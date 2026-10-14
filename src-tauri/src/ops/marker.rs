//! "从该节点继续"标记行原语（CONTRACT §4.7）。
//!
//! 经真实 omp TUI 验证：在文件末尾追加一行
//! `{"type":"custom","customType":"omp-resume-branch",...}` 会使
//! `omp --resume` 把 leaf 重建为该 marker 并从 `parentId` 继续；
//! custom 条目不渲染、不进模型上下文，未知 customType 可容忍。
//! omp **不校验** `parentId`（错 id 静默给出空分支），因此调用方必须先
//! 把 `nodeId` 校验为保留节点——本模块只负责写，不负责验。

use std::collections::hash_map::RandomState;
use std::collections::HashSet;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::{AppError, ErrorCode};

/// 分支标记的 customType（CONTRACT §9 `MARKER_CUSTOM_TYPE`）。
pub const MARKER_CUSTOM_TYPE: &str = "omp-resume-branch";

/// marker id 碰撞重试上限；耗尽后回退为更长的 id（见 [`new_marker_id`]）。
const MAX_ID_RETRIES: u32 = 1000;

/// 读 4 字节系统熵；`/dev/urandom` 不可用时回退为时间/pid/哈希混合。
fn random_u32() -> u32 {
    let mut buf = [0u8; 4];
    let from_os = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf).map(|_| ()))
        .is_ok();
    if from_os {
        return u32::from_ne_bytes(buf);
    }
    static FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let mut h = RandomState::new().build_hasher();
    h.write_u128(nanos);
    h.write_u32(pid);
    h.write_u64(FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed));
    let mixed = h.finish() ^ (nanos as u64) ^ ((pid as u64) << 32);
    (mixed ^ (mixed >> 32)) as u32
}

/// 生成一个文件内唯一的 marker id：8 位小写十六进制。
///
/// 碰撞则重抽；重抽 [`MAX_ID_RETRIES`] 次仍碰撞（基本不可能）时回退为
/// 16 位小写十六进制——与 omp "8-hex 耗尽回退 Snowflake" 的不定宽惯例一致，
/// 解析器不得假设 id 定宽。
pub fn new_marker_id(existing: &HashSet<String>) -> String {
    new_marker_id_with(existing, &mut || format!("{:08x}", random_u32()))
}

fn new_marker_id_with(existing: &HashSet<String>, gen: &mut dyn FnMut() -> String) -> String {
    for _ in 0..MAX_ID_RETRIES {
        let id = gen();
        if !existing.contains(&id) {
            return id;
        }
    }
    loop {
        let id = format!("{:08x}{:08x}", random_u32(), random_u32());
        if !existing.contains(&id) {
            return id;
        }
    }
}

#[derive(serde::Serialize)]
struct MarkerLine<'a> {
    #[serde(rename = "type")]
    entry_type: &'static str,
    #[serde(rename = "customType")]
    custom_type: &'static str,
    id: &'a str,
    #[serde(rename = "parentId")]
    parent_id: &'a str,
    timestamp: &'a str,
    data: serde_json::Value,
}

/// 构造 marker 行：紧凑 JSON、字段顺序固定、末尾含 `\n`。
///
/// 字段顺序：`type, customType, id, parentId, timestamp, data`
///（serde struct 按声明顺序序列化；`serde_json` 已是本 crate 依赖，未新增）。
/// id 中的特殊字符由 JSON 转义正确处理。
pub fn build_marker_line(marker_id: &str, parent_id: &str, now_iso: &str) -> String {
    let line = MarkerLine {
        entry_type: "custom",
        custom_type: MARKER_CUSTOM_TYPE,
        id: marker_id,
        parent_id,
        timestamp: now_iso,
        data: serde_json::Value::Object(Default::default()),
    };
    // struct 序列化不可能失败。
    let mut s = serde_json::to_string(&line).expect("marker line serialization is infallible");
    s.push('\n');
    s
}

/// 当前 UTC 时间，`YYYY-MM-DDTHH:MM:SS.mmmZ`（CONTRACT §0 时间格式）。
/// 纯 std 实现（`SystemTime` + 手工 civil-from-days）。
pub fn now_iso_utc_ms() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    format_iso_ms(ms)
}

/// 把 unix 毫秒格式化为 ISO-8601 UTC（支持负值；`{:04}` 保证至少 4 位年）。
fn format_iso_ms(ms_since_epoch: i64) -> String {
    let secs = ms_since_epoch.div_euclid(1000);
    let millis = ms_since_epoch.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let second_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
    )
}

/// days（unix 纪元起）→ (年, 月, 日)，Howard Hinnant 算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 以 `O_APPEND` 单次 `write_all` 追加 marker 行。
///
/// 先自卫：目标必须是常规文件且**不是符号链接**；文件非空且最后一个字节
/// 必须是 `\n`（否则报 `IO`："文件末尾不是换行，疑似写入未完成，已拒绝追加"，
/// 与 CONTRACT §4.7 一致）；`line` 本身必须以 `\n` 结尾。
/// 不存在 → `NOT_FOUND`，目录等 → `IO`。
///
/// 符号链接在此直接拒绝：`validate_session_path` 的 canonicalize 只保证校验
/// 瞬间的位置合法，校验→追加之间文件若被换成指向根外的链接，跟随写入会把
/// marker 追加到受害文件末尾。此处先 `symlink_metadata` 快拒，再以
/// `O_NOFOLLOW` 打开（关闭“检查→打开”竞态窗口；见 safety 集成测试）。
pub fn append_marker_line(path: &Path, line: &str) -> Result<(), AppError> {
    if !line.ends_with('\n') {
        return Err(AppError::new(
            ErrorCode::Io,
            "拒绝追加：marker 行必须以换行结尾",
        ));
    }
    // 快拒：最后一段是符号链接即拒绝（不跟随）。
    match std::fs::symlink_metadata(path) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("拒绝追加：是符号链接：{}", path.display()),
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", path.display()),
            ));
        }
        Err(e) => {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("无法访问会话文件 {}：{e}", path.display()),
            ));
        }
    }
    let md = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                ErrorCode::NotFound,
                format!("会话文件不存在：{}", path.display()),
            )
        } else {
            AppError::new(
                ErrorCode::Io,
                format!("无法访问会话文件 {}：{e}", path.display()),
            )
        }
    })?;
    if !md.is_file() {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("拒绝追加：不是常规文件：{}", path.display()),
        ));
    }
    if md.len() == 0 {
        return Err(unfinished_error(path));
    }
    let mut f = open_no_follow_read(path)?;
    f.seek(SeekFrom::End(-1)).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("无法定位会话文件末尾 {}：{e}", path.display()),
        )
    })?;
    let mut last = [0u8; 1];
    f.read_exact(&mut last).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("无法读取会话文件末尾 {}：{e}", path.display()),
        )
    })?;
    if last[0] != b'\n' {
        return Err(unfinished_error(path));
    }
    let mut app = open_no_follow_append(path)?;
    app.write_all(line.as_bytes()).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("追加会话文件 {} 失败：{e}", path.display()),
        )
    })?;
    Ok(())
}
/// 以 `O_NOFOLLOW` 只读打开：路径末段若在打开瞬间是符号链接则失败，
/// 关闭 `symlink_metadata` 检查→`open` 之间的竞态窗口。
#[cfg(unix)]
fn open_no_follow_read(path: &Path) -> Result<std::fs::File, AppError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            AppError::new(
                ErrorCode::Io,
                format!("无法读取会话文件 {}：{e}", path.display()),
            )
        })
}
/// 以 `O_APPEND | O_NOFOLLOW` 打开追加：同上，末段链接即失败。
#[cfg(unix)]
fn open_no_follow_append(path: &Path) -> Result<std::fs::File, AppError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .append(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| {
            AppError::new(
                ErrorCode::Io,
                format!("无法追加会话文件 {}：{e}", path.display()),
            )
        })
}
/// 非 unix 回退（本应用仅跑 macOS，此分支理论不可达）：与原来一样跟随打开，
/// 但前面的 `symlink_metadata` 快拒仍有效。
#[cfg(not(unix))]
fn open_no_follow_read(path: &Path) -> Result<std::fs::File, AppError> {
    std::fs::File::open(path).map_err(|e| {
        AppError::new(
            ErrorCode::Io,
            format!("无法读取会话文件 {}：{e}", path.display()),
        )
    })
}
#[cfg(not(unix))]
fn open_no_follow_append(path: &Path) -> Result<std::fs::File, AppError> {
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| {
            AppError::new(
                ErrorCode::Io,
                format!("无法追加会话文件 {}：{e}", path.display()),
            )
        })
}

fn unfinished_error(path: &Path) -> AppError {
    AppError::new(
        ErrorCode::Io,
        format!(
            "文件末尾不是换行，疑似写入未完成，已拒绝追加：{}",
            path.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "omp-resume-ops-marker-{}-{}-{}",
            std::process::id(),
            n,
            name
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn is_hex8(s: &str) -> bool {
        s.len() == 8
            && s.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }

    #[test]
    fn marker_id_format_and_uniqueness() {
        let mut existing = HashSet::new();
        for _ in 0..200 {
            let id = new_marker_id(&existing);
            assert!(is_hex8(&id), "bad id: {id}");
            assert!(!existing.contains(&id));
            existing.insert(id);
        }
    }

    #[test]
    fn marker_id_avoids_existing() {
        let first = new_marker_id(&HashSet::new());
        let mut existing = HashSet::new();
        existing.insert(first.clone());
        for _ in 0..50 {
            let id = new_marker_id(&existing);
            assert_ne!(id, first);
            existing.insert(id);
        }
    }

    #[test]
    fn marker_id_fallback_after_collisions() {
        // stub 生成器永远返回同一个已存在的 id → 触发 16 位回退。
        let mut existing = HashSet::new();
        existing.insert("deadbeef".to_owned());
        let id = new_marker_id_with(&existing, &mut || "deadbeef".to_owned());
        assert_ne!(id, "deadbeef");
        assert_eq!(id.len(), 16);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(!existing.contains(&id));
    }

    #[test]
    fn build_marker_line_shape_and_escaping() {
        let line = build_marker_line("abc12345", "node9", "2026-10-14T02:18:47.387Z");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "必须恰好一行：{line}");
        assert_eq!(
            line,
            "{\"type\":\"custom\",\"customType\":\"omp-resume-branch\",\
             \"id\":\"abc12345\",\"parentId\":\"node9\",\
             \"timestamp\":\"2026-10-14T02:18:47.387Z\",\"data\":{}}\n"
        );
        // 特殊字符被 JSON 正确转义，且仍是合法单行 JSON。
        let tricky = build_marker_line("a\"b\\c", "x\ny\"z", "2026-10-14T02:18:47.387Z");
        let v: serde_json::Value = serde_json::from_str(tricky.trim_end()).unwrap();
        assert_eq!(v["id"], "a\"b\\c");
        assert_eq!(v["parentId"], "x\ny\"z");
        assert_eq!(v["type"], "custom");
        assert_eq!(v["customType"], MARKER_CUSTOM_TYPE);
        assert_eq!(v["timestamp"], "2026-10-14T02:18:47.387Z");
        assert_eq!(v["data"], serde_json::Value::Object(Default::default()));
    }

    #[test]
    fn marker_line_field_order() {
        // 字段顺序固定（与 CONTRACT §4.7 示例一致）。
        let line = build_marker_line("id1", "p1", "t");
        let order = [
            "\"type\"",
            "\"customType\"",
            "\"id\"",
            "\"parentId\"",
            "\"timestamp\"",
            "\"data\"",
        ];
        let mut last = 0;
        for key in order {
            let pos = line.find(key).unwrap();
            assert!(pos >= last, "field order broken: {line}");
            last = pos;
        }
    }

    #[test]
    fn iso_format_known_epochs() {
        assert_eq!(format_iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso_ms(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(format_iso_ms(1700000000000), "2023-11-14T22:13:20.000Z");
        assert_eq!(format_iso_ms(1709164800000), "2024-02-29T00:00:00.000Z"); // 闰年 2/29
        assert_eq!(format_iso_ms(951782400000), "2000-02-29T00:00:00.000Z"); // 整百年闰年
        assert_eq!(format_iso_ms(951782400123), "2000-02-29T00:00:00.123Z"); // 毫秒位
        assert_eq!(format_iso_ms(-1000), "1969-12-31T23:59:59.000Z"); // 纪元前
        assert_eq!(format_iso_ms(1791793713325), "2026-10-12T08:28:33.325Z");
    }

    #[test]
    fn now_iso_shape() {
        let s = now_iso_utc_ms();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[10..11], "T");
        assert_eq!(&s[19..20], ".");
        // 自洽：解析回毫秒应接近当前时间（±60s）。
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let parsed = parse_iso_ms(&s);
        assert!((now_ms - parsed).abs() < 60_000, "{s} vs {now_ms}");
    }

    /// 测试辅助：把 format_iso_ms 的输出解析回毫秒（与实现独立的手写解析）。
    fn parse_iso_ms(s: &str) -> i64 {
        let y: i64 = s[0..4].parse().unwrap();
        let mo: i64 = s[5..7].parse().unwrap();
        let d: i64 = s[8..10].parse().unwrap();
        let h: i64 = s[11..13].parse().unwrap();
        let mi: i64 = s[14..16].parse().unwrap();
        let sec: i64 = s[17..19].parse().unwrap();
        let ms: i64 = s[20..23].parse().unwrap();
        let days = days_from_civil(y, mo as u32, d as u32);
        (days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms
    }

    fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let mp = ((m + 9) % 12) as i64;
        let doy = (153 * mp + 2) / 5 + d as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    #[test]
    fn append_exactly_one_line_prefix_identical() {
        let root = test_dir("append");
        let p = root.join("s.jsonl");
        let before = "{\"type\":\"session\",\"version\":3,\"id\":\"x\"}\n{\"type\":\"message\",\"id\":\"a\"}\n";
        std::fs::write(&p, before).unwrap();
        let line = build_marker_line("m1234567", "a", now_iso_utc_ms().as_str());
        append_marker_line(&p, &line).unwrap();
        let after = std::fs::read(&p).unwrap();
        assert_eq!(after, [before.as_bytes(), line.as_bytes()].concat());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn append_refuses_unfinished_tail() {
        let root = test_dir("notail");
        let p = root.join("s.jsonl");
        std::fs::write(&p, "{\"partial\": true}").unwrap(); // 无末尾换行
        let err = append_marker_line(&p, "{\"a\":1}\n").unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert!(err.message.contains("文件末尾不是换行"), "{err:?}");
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"partial\": true}");
        // 空文件同样拒绝。
        let e = root.join("empty.jsonl");
        std::fs::write(&e, "").unwrap();
        let err = append_marker_line(&e, "{\"a\":1}\n").unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn append_refuses_bad_targets_and_bad_line() {
        let root = test_dir("badtarget");
        let err = append_marker_line(&root.join("nope.jsonl"), "{\"a\":1}\n").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = append_marker_line(&root, "{\"a\":1}\n").unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        let p = root.join("s.jsonl");
        std::fs::write(&p, "{}\n").unwrap();
        let err = append_marker_line(&p, "no-newline").unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(std::fs::read(&p).unwrap(), b"{}\n");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn concurrent_appends_do_not_interleave() {
        let root = test_dir("concurrent");
        let p = root.join("s.jsonl");
        std::fs::write(&p, "{\"type\":\"session\"}\n").unwrap();
        let per_thread = 25;
        std::thread::scope(|s| {
            for t in 0..2 {
                let p = &p;
                s.spawn(move || {
                    for i in 0..per_thread {
                        let line = build_marker_line(
                            &format!("t{t}{i:06x}"),
                            "parent",
                            "2026-10-14T02:18:47.387Z",
                        );
                        append_marker_line(p, &line).unwrap();
                    }
                });
            }
        });
        let content = std::fs::read_to_string(&p).unwrap();
        let mut lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 1 + 2 * per_thread, "行数不对（缺行/断行）");
        assert_eq!(lines.remove(0), "{\"type\":\"session\"}");
        // 每行都完整可解析，无交错、无截断。
        let mut ids = HashSet::new();
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).expect("断行/交错");
            assert_eq!(v["customType"], MARKER_CUSTOM_TYPE);
            assert!(
                ids.insert(v["id"].as_str().unwrap().to_owned()),
                "重复/损坏"
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
