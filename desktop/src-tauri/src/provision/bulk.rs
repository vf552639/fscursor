use sha2::{Digest, Sha256};

pub fn idempotency_key(action: &str, domain_ids: &[String]) -> String {
    let mut ids: Vec<_> = domain_ids.iter().cloned().collect();
    ids.sort();
    let mut h = Sha256::new();
    use std::io::Write;
    let _ = h.write_all(action.as_bytes());
    let _ = h.write_all(b"\n");
    for id in &ids {
        let _ = h.write_all(id.as_bytes());
        let _ = h.write_all(b"\n");
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_key() {
        let a = idempotency_key("x", &["b".into(), "a".into()]);
        let b = idempotency_key("x", &["a".into(), "b".into()]);
        assert_eq!(a, b);
    }
}
