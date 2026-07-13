//! Credential-bearing config persistence. On Windows the whole JSON document is encrypted with
//! the current user's DPAPI key before the existing atomic file replacement; legacy plaintext JSON
//! is migrated on first successful read. The non-Windows implementation stays plaintext so pure
//! backend tests can run on CI even though the application itself is Windows-only.

use std::path::Path;

const PREFIX: &str = "widgetsack-dpapi-v1:";

pub fn read(path: &Path) -> Result<Option<String>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    if let Some(encoded) = raw.strip_prefix(PREFIX) {
        let encrypted = hex_decode(encoded)?;
        let clear = unprotect(&encrypted)?;
        return String::from_utf8(clear)
            .map(Some)
            .map_err(|e| format!("decrypted config is not UTF-8: {e}"));
    }

    // Existing installs have plaintext JSON. Return it only after replacing the file with the
    // protected representation, so merely launching the upgraded app completes the migration.
    write(path, &raw)?;
    Ok(Some(raw))
}

pub fn write(path: &Path, contents: &str) -> Result<(), String> {
    let protected = protect(contents.as_bytes())?;
    let payload = format!("{PREFIX}{}", hex_encode(&protected));
    crate::command::atomic_write(path, &payload)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("protected config has odd-length hex data".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let hi = hex_nibble(pair[0])?;
            let lo = hex_nibble(pair[1])?;
            Ok((hi << 4) | lo)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("protected config contains non-hex data".into()),
    }
}

#[cfg(not(windows))]
fn protect(clear: &[u8]) -> Result<Vec<u8>, String> {
    Ok(clear.to_vec())
}

#[cfg(not(windows))]
fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    Ok(encrypted.to_vec())
}

#[cfg(windows)]
fn protect(clear: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::PCWSTR;

    let input = CRYPT_INTEGER_BLOB {
        cbData: clear
            .len()
            .try_into()
            .map_err(|_| "config is too large for DPAPI".to_string())?,
        pbData: clear.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|e| format!("DPAPI protect failed: {e}"))?;
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(result)
}

#[cfg(windows)]
fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted
            .len()
            .try_into()
            .map_err(|_| "protected config is too large for DPAPI".to_string())?,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|e| format!("DPAPI unprotect failed: {e}"))?;
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip_and_validation() {
        let bytes = b"\0WidgetSack\xff";
        assert_eq!(hex_decode(&hex_encode(bytes)).unwrap(), bytes);
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
    }

    #[test]
    fn protection_round_trip() {
        let clear = b"{\"token\":\"secret\"}";
        assert_eq!(unprotect(&protect(clear).unwrap()).unwrap(), clear);
    }

    #[test]
    fn legacy_plaintext_is_migrated_on_first_read() {
        let dir = std::env::temp_dir().join(format!(
            "widgetsack-secure-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secret.json");
        let clear = "{\"token\":\"secret\"}";
        std::fs::write(&path, clear).unwrap();

        assert_eq!(read(&path).unwrap().as_deref(), Some(clear));
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(stored.starts_with(PREFIX));
        assert!(!stored.contains("secret"));
        assert_eq!(read(&path).unwrap().as_deref(), Some(clear));

        std::fs::remove_dir_all(dir).unwrap();
    }
}
