#![cfg(target_os = "linux")]
use glib::variant::ToVariant;

#[test]
fn gtk_string_iteration_uses_a_mutable_c_out_pointer() {
    let value = vec!["first", "second", "third"].to_variant();
    let mut iter = value.array_iter_str().expect("string array");
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("third"));
    assert_eq!(iter.last(), Some("second"));
    assert_eq!(value.array_iter_str().unwrap().nth(1), Some("second"));
    assert_eq!(value.array_iter_str().unwrap().nth_back(1), Some("second"));
}
