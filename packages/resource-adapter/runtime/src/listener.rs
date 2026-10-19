use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    net::{UnixListener, UnixStream},
    time::timeout,
};

pub struct Listener {
    pub socket: UnixListener,
    path: PathBuf,
    inode: u64,
    _lock: File,
}

impl Listener {
    pub async fn bind(path: &Path, owner: u32) -> io::Result<Self> {
        let parent = fs::metadata(
            path.parent()
                .ok_or_else(|| io::Error::other("socket parent required"))?,
        )?;
        if parent.uid() != owner || parent.mode() & 0o022 != 0 {
            return Err(io::Error::other(
                "socket directory must be owned by the supervisor and not writable by workers",
            ));
        }
        let lock_path = PathBuf::from(format!("{}.lock", path.display()));
        match fs::symlink_metadata(&lock_path) {
            Ok(meta)
                if !meta.is_file()
                    || meta.uid() != owner
                    || meta.mode() & 0o077 != 0
                    || meta.nlink() != 1 =>
            {
                return Err(io::Error::other("invalid coordinator lock file"));
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        // Keep the inode: unlinking a lock file would allow two processes to hold different locks.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;
        lock.try_lock()
            .map_err(|error| io::Error::other(format!("coordinator already running: {error}")))?;
        match fs::symlink_metadata(path) {
            Ok(meta) => {
                if !meta.file_type().is_socket() || meta.uid() != owner {
                    return Err(io::Error::other("refusing to replace a non-owned socket"));
                }
                match timeout(Duration::from_secs(1), UnixStream::connect(path)).await {
                    Ok(Err(error)) if error.kind() == io::ErrorKind::ConnectionRefused => {
                        fs::remove_file(path)?
                    }
                    _ => {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            "socket is still active",
                        ));
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let socket = UnixListener::bind(path)?;
        let listener = Self {
            socket,
            path: path.into(),
            inode: fs::symlink_metadata(path)?.ino(),
            _lock: lock,
        };
        fs::set_permissions(path, fs::Permissions::from_mode(0o666))?;
        Ok(listener)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|meta| meta.file_type().is_socket() && meta.ino() == self.inode)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recovers_only_stale_sockets_and_keeps_live_owners() {
        let directory =
            std::env::temp_dir().join(format!("coordinator-listener-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let owner = fs::metadata(&directory).unwrap().uid();
        let path = directory.join("public.sock");
        fs::write(&path, "keep").unwrap();
        assert!(Listener::bind(&path, owner).await.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        fs::remove_file(&path).unwrap();
        let unmanaged = UnixListener::bind(&path).unwrap();
        assert!(Listener::bind(&path, owner).await.is_err());
        assert!(UnixStream::connect(&path).await.is_ok());
        drop(unmanaged);
        let listener = Listener::bind(&path, owner).await.unwrap();
        assert!(Listener::bind(&path, owner).await.is_err());
        assert!(UnixStream::connect(&path).await.is_ok());
        drop(listener);
        assert!(!path.exists());
        let listener = Listener::bind(&path, owner).await.unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, "replacement").unwrap();
        drop(listener);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        fs::remove_dir_all(directory).unwrap();
    }
}
