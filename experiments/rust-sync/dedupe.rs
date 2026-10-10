//! Isolated index-only projection of deltaPipeline.deduplicateDeltas.
//! JS retains payloads, validation, group handling, storage, and acknowledgement.
use std::hint::black_box;
use std::io::{self, Read, Write};
use std::time::Instant;

fn dedupe(ids: &[f64]) -> Option<Vec<usize>> {
    if ids.len() < 2 || ids.iter().any(|id| *id <= 0.0) {
        return None; // The caller must return the original array by identity.
    }
    if ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return None;
    }
    let mut indices: Vec<usize> = (0..ids.len()).collect();
    // Stable sort preserves the FIRST payload on equal IDs, including signed zero.
    indices.sort_by(|a, b| ids[*a].partial_cmp(&ids[*b]).unwrap());
    indices.dedup_by(|a, b| ids[*a] == ids[*b]);
    Some(indices)
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut header = [0u8; 8];
        // A clean EOF is the only successful shutdown; partial requests fail.
        if input.read(&mut header[..1])? == 0 { return Ok(()); }
        input.read_exact(&mut header[1..])?;
        let count = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let repeats = u32::from_le_bytes(header[4..].try_into().unwrap());
        if count > 1_000_000 || repeats == 0 || repeats > 100_000 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid experiment request"));
        }
        let mut bytes = vec![0; count * 8];
        input.read_exact(&mut bytes)?;
        let ids: Vec<f64> = bytes.chunks_exact(8)
            .map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
        if ids.iter().any(|id| !id.is_finite()) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "non-finite id"));
        }
        let start = Instant::now();
        for _ in 0..repeats { black_box(dedupe(black_box(&ids))); }
        let nanos = start.elapsed().as_nanos() as u64;
        let result = dedupe(&ids);
        let count = result.as_ref().map_or(u32::MAX, |v| v.len() as u32);
        output.write_all(&count.to_le_bytes())?;
        output.write_all(&nanos.to_le_bytes())?;
        if let Some(indices) = result {
            for index in indices { output.write_all(&(index as u32).to_le_bytes())?; }
        }
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_replay_and_bypass() {
        assert_eq!(dedupe(&[3., 1., 2., 3.]), Some(vec![1, 2, 0]));
        assert_eq!(dedupe(&[1., 2., 3.]), None);
        assert_eq!(dedupe(&[3., 0., 3.]), None);
        assert_eq!(dedupe(&[3., -1., 3.]), None);
        assert_eq!(dedupe(&[]), None);
        assert_eq!(dedupe(&[1.5, 1.25, 1.5]), Some(vec![1, 0]));
    }
}
