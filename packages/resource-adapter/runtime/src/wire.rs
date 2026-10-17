use serde_json::Value;
use std::{io, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

pub const FRAME_LIMIT: usize = 32 * 1024 * 1024;
pub struct Frame {
    pub bytes: Vec<u8>,
    _memory: Option<OwnedSemaphorePermit>,
}

pub async fn read<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    budget: &Arc<Semaphore>,
) -> io::Result<Option<Frame>> {
    let mut frame = Frame {
        bytes: Vec::new(),
        _memory: None,
    };
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if frame.bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::other("truncated frame"))
            };
        }
        let length = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        if frame.bytes.len() + length > FRAME_LIMIT {
            return Err(io::Error::other("frame limit"));
        }
        let permit = budget
            .clone()
            .try_acquire_many_owned(length as u32)
            .map_err(|_| io::Error::other("input budget"))?;
        if let Some(memory) = &mut frame._memory {
            memory.merge(permit);
        } else {
            frame._memory = Some(permit);
        }
        frame.bytes.extend_from_slice(&buffer[..length]);
        let complete = buffer[length - 1] == b'\n';
        reader.consume(length);
        if complete {
            return Ok(Some(frame));
        }
    }
}

pub async fn write<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(io::Error::other("response limit"));
    }
    bytes.push(b'\n');
    timeout(Duration::from_secs(5), writer.write_all(&bytes)).await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn frames_release_the_shared_budget_and_reject_truncation_and_overflow() {
        let budget = Arc::new(Semaphore::new(4));
        let mut reader = BufReader::with_capacity(1, &b"{}\n[]\n"[..]);
        let first = read(&mut reader, &budget).await.unwrap().unwrap();
        assert_eq!(first.bytes, b"{}\n");
        assert_eq!(budget.available_permits(), 1);
        drop(first);
        assert_eq!(budget.available_permits(), 4);
        assert_eq!(
            read(&mut reader, &budget).await.unwrap().unwrap().bytes,
            b"[]\n"
        );
        assert!(
            read(&mut BufReader::new(&b"{}"[..]), &budget)
                .await
                .is_err()
        );
        assert!(
            read(&mut BufReader::new(&b"12345\n"[..]), &budget)
                .await
                .is_err()
        );
        assert_eq!(budget.available_permits(), 4);
    }
}
