//! Debug-only guards so audit metadata never includes obvious secret field names.

pub fn redact_check_metadata(v: &serde_json::Value) {
    let s = serde_json::to_string(v).unwrap_or_default().to_lowercase();
    debug_assert!(
        !s.contains("password"),
        "audit metadata must not contain password"
    );
    debug_assert!(
        !s.contains("\"auth_key\""),
        "audit metadata must not contain auth_key"
    );
    debug_assert!(
        !s.contains("\"api_key\""),
        "audit metadata must not contain api_key"
    );
}
