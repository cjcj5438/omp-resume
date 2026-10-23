//! 时间窗口与分桶。
use chrono::{DateTime, Duration, TimeZone, Timelike, Utc};

use crate::model::{TrendUnit, UsageRange};

/// 时间窗口：毫秒起止（仅 All 为 None 表不限；固定窗口起止恒为 Some）
/// 分桶单位 + 固定窗口的预设桶 key（升序）。
pub(super) struct Window {
    pub(super) start_ms: Option<i64>,
    pub(super) end_ms: Option<i64>,
    pub(super) unit: TrendUnit,
    pub(super) keys: Vec<String>,
}

/// 本地 naive 时刻 → epoch 毫秒。返回 None 仅表示该本地时刻不存在
/// （DST“春季前跳”缺口，如 02:00–03:00），绝不表示“起点不限”——
/// 固定窗口起点必须经 `resolve_start_ms` 解析为绝对时间，禁止把 None
/// 直接装进 `Window.start_ms`（`in_window` 会把 None 起点当作不限，
/// 固定窗口将静默变成全量统计）。
pub(super) fn local_millis<Tz: TimeZone>(
    timezone: &Tz,
    naive: &chrono::NaiveDateTime,
) -> Option<i64>
where
    Tz::Offset: std::fmt::Display,
{
    timezone
        .from_local_datetime(naive)
        .earliest()
        .map(|t| t.timestamp_millis())
}

/// 固定窗口起点解析（恒返回绝对时间，绝不为 None）：
/// 起点本地时刻若落在 DST 缺口内，向前取第一个存在的时刻（+1h 步进、
/// 最多 3 次，覆盖常见 <3h 跳变）；整日跳过等极端情况仍失败时用
/// `fallback_ms`（调用方保证为 ≤ now 且不早于 now−窗口长度的合理下界）。
pub(super) fn resolve_start_ms<Tz: TimeZone>(
    timezone: &Tz,
    naive: &chrono::NaiveDateTime,
    fallback_ms: i64,
) -> i64
where
    Tz::Offset: std::fmt::Display,
{
    let mut candidate = *naive;
    for _ in 0..4 {
        if let Some(ms) = local_millis(timezone, &candidate) {
            return ms;
        }
        candidate += Duration::hours(1);
    }
    fallback_ms
}

/// 近 N 个自然日窗口（含今天，自首日 0 点起）：7d/30d 与活跃度热力图共用。
pub(super) fn trailing_days<Tz: TimeZone>(days: i64, now: DateTime<Utc>, timezone: &Tz) -> Window
where
    Tz::Offset: std::fmt::Display,
{
    let local = now.with_timezone(timezone);
    let today = local.date_naive();
    let dates: Vec<_> = (0..days)
        .rev()
        .map(|i| {
            today
                .checked_sub_signed(Duration::days(i))
                .expect("日期回退恒合法")
        })
        .collect();
    let keys = dates
        .iter()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .collect();
    let first_midnight = dates[0].and_hms_opt(0, 0, 0).expect("午夜恒合法");
    let floor_ms = now.timestamp_millis() - Duration::days(days).num_milliseconds();
    Window {
        start_ms: Some(resolve_start_ms(timezone, &first_midnight, floor_ms)),
        end_ms: Some(now.timestamp_millis()),
        unit: TrendUnit::Day,
        keys,
    }
}
/// 本地时区窗口：
/// today 当天 0 点起；24h 当前整点前推 23 小时（24 个整点桶）；
/// 7d/30d 含今天的自然日；all 不限。
/// 固定窗口的 start_ms 恒为 Some，只有 All 为 None：24h 由 now 的绝对时间截断
/// 本地整点再减 23h（不经 earliest，无缺口/重复歧义）；today/7d/30d 的午夜缺口
/// 经 resolve_start_ms 前跳到缺口后第一个存在的时刻。
pub(super) fn window_at<Tz: TimeZone>(
    range: UsageRange,
    now: DateTime<Utc>,
    timezone: &Tz,
) -> Window
where
    Tz::Offset: std::fmt::Display,
{
    let end_ms = match range {
        UsageRange::All => None,
        _ => Some(now.timestamp_millis()),
    };
    let local = now.with_timezone(timezone);
    match range {
        UsageRange::Today => {
            let date = local.date_naive();
            let midnight = date.and_hms_opt(0, 0, 0).expect("午夜恒合法");
            let keys = (0..=local.hour())
                .map(|h| format!("{} {h:02}", date.format("%Y-%m-%d")))
                .collect();
            Window {
                start_ms: Some(resolve_start_ms(
                    timezone,
                    &midnight,
                    now.timestamp_millis() - Duration::days(1).num_milliseconds(),
                )),
                end_ms,
                unit: TrendUnit::Hour,
                keys,
            }
        }
        UsageRange::Last24Hours => {
            let hour_start = local
                .date_naive()
                .and_hms_opt(local.hour(), 0, 0)
                .expect("整点恒合法");
            let first = hour_start - Duration::hours(23);
            let keys = (0..24)
                .map(|i| {
                    (first + Duration::hours(i))
                        .format("%Y-%m-%d %H")
                        .to_string()
                })
                .collect();
            Window {
                // 绝对时间起点：now 减去本地挂钟已过整点分数，即当前本地整点的
                // 绝对毫秒（半小时偏移同样成立；重复整点自然取 now 所在的一次；
                // 不经 earliest()，无缺口/重复歧义），再减 23 小时。
                start_ms: Some(
                    now.timestamp_millis()
                        - (local.minute() as i64 * 60 + local.second() as i64) * 1000
                        - (local.nanosecond() / 1_000_000) as i64
                        - Duration::hours(23).num_milliseconds(),
                ),
                end_ms,
                unit: TrendUnit::Hour,
                keys,
            }
        }
        UsageRange::Last7Days => trailing_days(7, now, timezone),
        UsageRange::Last30Days => trailing_days(30, now, timezone),
        UsageRange::All => Window {
            start_ms: None,
            end_ms: None,
            unit: TrendUnit::Day,
            keys: Vec::new(),
        },
    }
}

/// 窗口过滤：无时间戳条目只进入 all（带窗口统计无法安置它们）；
/// 固定窗口上下界为 [起点, now]（起点恒为 Some，见 resolve_start_ms，此处 None 分支只服务 All），
/// 未来时间戳不计入（保证分桶合计恒等于总计）。
pub(super) fn in_window(window: &Window, timestamp: Option<i64>) -> bool {
    match timestamp {
        None => window.start_ms.is_none() && window.end_ms.is_none(),
        Some(t) => window.start_ms.is_none_or(|s| t >= s) && window.end_ms.is_none_or(|e| t <= e),
    }
}

pub(super) fn bucket_key<Tz: TimeZone>(unit: TrendUnit, ms: i64, timezone: &Tz) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    let local = Utc
        .timestamp_millis_opt(ms)
        .single()?
        .with_timezone(timezone);
    Some(match unit {
        TrendUnit::Hour => local.format("%Y-%m-%d %H").to_string(),
        TrendUnit::Day => local.format("%Y-%m-%d").to_string(),
    })
}

/// 分桶 + 钳位一步到位。
pub(super) fn bucketed_key<Tz: TimeZone>(window: &Window, ms: i64, timezone: &Tz) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    let mut key = bucket_key(window.unit, ms, timezone)?;
    clamp_key(window, &mut key);
    Some(key)
}

/// 固定窗口钳位：夏令时跳变等极端情况导致桶 key 落到预设范围外时，
/// 归入首/末桶，保证分桶合计恒等于总计。
pub(super) fn clamp_key(window: &Window, key: &mut String) {
    if window.keys.is_empty() {
        return;
    }
    if key.as_str() < window.keys[0].as_str() {
        *key = window.keys[0].clone();
    } else if key.as_str() > window.keys[window.keys.len() - 1].as_str() {
        *key = window.keys[window.keys.len() - 1].clone();
    }
}
