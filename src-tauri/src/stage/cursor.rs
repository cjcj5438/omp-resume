//! jsonl 增量读取游标（只读）。
//!
//! 与 `menubar/tail.rs` 的读取语义一致，但状态独立：那边的游标与私有
//! `TailState` 焊死，抽取会动已验证的菜单栏检测路径，这里自带 ~60 行实现。
//!
//! 语义：
//! - 首次或长度回退（截断/替换）→ 先 `reset()`，再从头单遍读完；
//! - 长度不变 → 什么都不做；
//! - 否则 seek 到已消费偏移只读新增字节；
//! - 末行无 `\n` → 偏移停在该行行首，留待下轮；
//! - 单行超过 [`MAX_LINE_BYTES`] 跳过（不回调）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 单行上限，与 `menubar::tail::MAX_LINE_BYTES` 同值。
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 逐行回调接收方：重置状态 + 消费一行。
pub trait LineSink {
    /// 文件从头重读（首次或截断）：丢弃全部旧状态。
    fn reset(&mut self);
    /// 一行完整内容（已去 `\n` 与尾部 `\r`，非空，长度 ≤ [`MAX_LINE_BYTES`]）。
    fn line(&mut self, line: &[u8]);
}

/// 单个 jsonl 的已消费偏移。
#[derive(Debug, Default)]
pub struct JsonlCursor {
    offset: u64,
    seeded: bool,
}

impl JsonlCursor {
    /// 推进到文件末尾。文件不可读 → `Err`（调用方保留旧状态、跳过本轮）。
    pub fn advance(&mut self, path: &Path, sink: &mut impl LineSink) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if !self.seeded || len < self.offset {
            sink.reset();
            let mut bytes = Vec::with_capacity(len as usize);
            file.read_to_end(&mut bytes)?;
            self.consume(&bytes, bytes.len() as u64, sink);
            self.seeded = true;
            return Ok(());
        }
        if len == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut chunk = Vec::with_capacity((len - self.offset) as usize);
        file.read_to_end(&mut chunk)?;
        self.consume(&chunk, len, sink);
        Ok(())
    }

    fn consume(&mut self, chunk: &[u8], abs_end: u64, sink: &mut impl LineSink) {
        let ends_complete = chunk.is_empty() || chunk.ends_with(b"\n");
        let mut start = 0usize;
        for (i, b) in chunk.iter().enumerate() {
            if *b != b'\n' {
                continue;
            }
            let line = &chunk[start..i];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if !line.is_empty() && line.len() <= MAX_LINE_BYTES {
                sink.line(line);
            }
            start = i + 1;
        }
        if ends_complete {
            self.offset = abs_end;
        } else {
            // 末行不完整：偏移停在该行行首。
            self.offset = abs_end - (chunk.len() - start) as u64;
        }
    }
}
