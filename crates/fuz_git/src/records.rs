//! NUL-terminated records (`-z`), shared by the read ops that parse them:
//! splitting, lossless paths, and quoting a bad record for an error.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

/// How much of an unrecognized record an error quotes.
pub const QUOTED_RECORD_CAP: usize = 80;

/// Splits `-z` output into its records, or returns the unterminated tail
/// when the last record lacks its NUL: git terminates every record, the last
/// one included, so a missing NUL means the output isn't what was asked for.
pub fn split_records(stdout: &[u8]) -> Result<impl Iterator<Item = &[u8]>, &[u8]> {
    let body = if stdout.is_empty() {
        None
    } else {
        Some(stdout.strip_suffix(b"\0").ok_or_else(|| {
            stdout
                .iter()
                .rposition(|&b| b == 0)
                .map_or(stdout, |nul| &stdout[nul + 1..])
        })?)
    };
    Ok(body.into_iter().flat_map(|b| b.split(|&c| c == 0)))
}

/// Sorts `names` by their bytes and makes them paths, losslessly.
pub fn to_paths(mut names: Vec<&[u8]>) -> Vec<PathBuf> {
    names.sort_unstable();
    names.into_iter().map(to_path).collect()
}

/// A path from git's bytes, losslessly.
fn to_path(name: &[u8]) -> PathBuf {
    PathBuf::from(OsString::from_vec(name.to_vec()))
}

/// An unrecognized record for an error message: lossily decoded, control
/// characters escaped, capped. Only enough bytes for the cap are decoded (a
/// char is at most 4), so a huge record isn't copied whole.
pub fn quote_record(record: &[u8]) -> String {
    let head = &record[..record.len().min(QUOTED_RECORD_CAP * 4)];
    String::from_utf8_lossy(head)
        .chars()
        .flat_map(char::escape_debug)
        .take(QUOTED_RECORD_CAP)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(stdout: &[u8]) -> Result<Vec<&[u8]>, &[u8]> {
        split_records(stdout).map(Iterator::collect)
    }

    #[test]
    fn splits_terminated_records() {
        assert_eq!(split(b""), Ok(vec![]));
        assert_eq!(split(b"a\0"), Ok(vec![&b"a"[..]]));
        assert_eq!(split(b"a\0\0b\0"), Ok(vec![&b"a"[..], b"", b"b"]));
        // the last record unterminated
        assert_eq!(split(b"a\0b"), Err(&b"b"[..]));
        assert_eq!(split(b"b"), Err(&b"b"[..]));
    }

    #[test]
    fn quotes_records_capped() {
        assert_eq!(quote_record(&[b'x'; 200]).len(), QUOTED_RECORD_CAP);
        // non-UTF-8 bytes past the cap's worth aren't decoded
        assert_eq!(
            quote_record(&[0xff; 1000]).chars().count(),
            QUOTED_RECORD_CAP
        );
        assert_eq!(quote_record(b"a\tb\xff"), "a\\tb\u{fffd}");
    }
}
