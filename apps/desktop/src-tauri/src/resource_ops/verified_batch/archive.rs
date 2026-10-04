//! Structural checks for opaque downloaded ZIP/JAR files. Inspect the bounded
//! central directory before zip allocates; resource contents are never extracted.
use super::{check, error, Result};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
use zip::{CompressionMethod, ZipArchive};
fn preflight_zip(file: &mut File) -> Result<(usize, u64)> {
    fn u16_at(b: &[u8], i: usize) -> u16 {
        u16::from_le_bytes(b[i..i + 2].try_into().expect("bounded ZIP field"))
    }
    fn u32_at(b: &[u8], i: usize) -> u32 {
        u32::from_le_bytes(b[i..i + 4].try_into().expect("bounded ZIP field"))
    }
    fn u64_at(b: &[u8], i: usize) -> u64 {
        u64::from_le_bytes(b[i..i + 8].try_into().expect("bounded ZIP field"))
    }
    let size = file.metadata().map_err(error)?.len();
    let tail_len = size.min(65557) as usize;
    if tail_len < 22 {
        return Err("ZIP 目录记录缺失".into());
    }
    file.seek(SeekFrom::Start(size - tail_len as u64))
        .map_err(error)?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail).map_err(error)?;
    let at = (0..=tail.len() - 22)
        .rev()
        .find(|i| {
            tail[*i..*i + 4] == [0x50, 0x4b, 0x05, 0x06]
                && *i + 22 + u16_at(&tail, *i + 20) as usize == tail.len()
        })
        .ok_or("ZIP 目录记录无效")?;
    let end = size - tail_len as u64 + at as u64;
    let eocd = &tail[at..at + 22];
    if u16_at(eocd, 4) != 0 || u16_at(eocd, 6) != 0 {
        return Err("不支持分卷 ZIP".into());
    }
    let mut count = u16_at(eocd, 10) as u64;
    let mut cd_size = u32_at(eocd, 12) as u64;
    let mut cd_offset = u32_at(eocd, 16) as u64;
    let mut cd_end = end;
    if count == u16::MAX as u64 || cd_size == u32::MAX as u64 || cd_offset == u32::MAX as u64 {
        if end < 20 {
            return Err("ZIP64 定位记录缺失".into());
        }
        file.seek(SeekFrom::Start(end - 20)).map_err(error)?;
        let mut locator = [0u8; 20];
        file.read_exact(&mut locator).map_err(error)?;
        if locator[..4] != [0x50, 0x4b, 0x06, 0x07]
            || u32_at(&locator, 4) != 0
            || u32_at(&locator, 16) != 1
        {
            return Err("ZIP64 定位或分卷声明无效".into());
        }
        let offset = u64_at(&locator, 8);
        if offset.checked_add(56).is_none_or(|n| n > end - 20) {
            return Err("ZIP64 目录偏移无效".into());
        }
        file.seek(SeekFrom::Start(offset)).map_err(error)?;
        let mut record = [0u8; 56];
        file.read_exact(&mut record).map_err(error)?;
        let record_size = u64_at(&record, 4);
        if record[..4] != [0x50, 0x4b, 0x06, 0x06]
            || !(44..=(1024 * 1024)).contains(&record_size)
            || offset.checked_add(12 + record_size) != Some(end - 20)
            || u32_at(&record, 16) != 0
            || u32_at(&record, 20) != 0
            || u64_at(&record, 24) != u64_at(&record, 32)
        {
            return Err("ZIP64 目录声明无效".into());
        }
        count = u64_at(&record, 32);
        cd_size = u64_at(&record, 40);
        cd_offset = u64_at(&record, 48);
        cd_end = offset;
    } else if u16_at(eocd, 8) != u16_at(eocd, 10) {
        return Err("ZIP 文件数量声明无效".into());
    }
    if count > 100_000
        || cd_size > (64 * 1024 * 1024)
        || cd_offset.checked_add(cd_size) != Some(cd_end)
    {
        return Err("ZIP 目录数量、大小或偏移超过安全限制".into());
    }
    file.seek(SeekFrom::Start(cd_offset)).map_err(error)?;
    let mut central = vec![0; cd_size as usize];
    file.read_exact(&mut central).map_err(error)?;
    let mut cursor = 0usize;
    let mut names = BTreeSet::new();
    for _ in 0..count {
        if cursor.checked_add(46).is_none_or(|n| n > central.len())
            || central[cursor..cursor + 4] != [0x50, 0x4b, 0x01, 0x02]
        {
            return Err("ZIP 中央目录记录无效".into());
        }
        let header = &central[cursor..cursor + 46];
        let name_len = u16_at(header, 28) as usize;
        let extra = u16_at(header, 30) as usize;
        let comment = u16_at(header, 32) as usize;
        if name_len == 0 || name_len > 4096 || u16_at(header, 34) != 0 || u16_at(header, 8) & 1 != 0
        {
            return Err("ZIP 包含无效路径、分卷或加密文件".into());
        }
        let next = cursor
            .checked_add(46 + name_len + extra + comment)
            .filter(|n| *n <= central.len())
            .ok_or("ZIP 中央目录字段越界")?;
        // These names stay inside an opaque ZIP/JAR; they are never extracted.
        // Preserve arbitrary name encodings while rejecting ambiguous duplicates.
        let raw = &central[cursor + 46..cursor + 46 + name_len];
        if !names.insert(raw.to_vec()) {
            return Err("ZIP 包含重复条目".into());
        }
        cursor = next;
    }
    if cursor != central.len() {
        return Err("ZIP 中央目录包含未声明记录".into());
    }
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    Ok((count as usize, cd_offset))
}
pub(super) fn validate(file: &mut File, cancel: &AtomicBool) -> Result<()> {
    check(cancel)?;
    let (count, central) = preflight_zip(file)?;
    let mut zip =
        ZipArchive::new(&mut *file).map_err(|e| format!("下载资源不是有效 ZIP/JAR：{e}"))?;
    if zip.len() != count {
        return Err("ZIP 条目数量与中央目录不一致".into());
    }
    for index in 0..count {
        check(cancel)?;
        let entry = zip
            .by_index_raw(index)
            .map_err(|e| format!("ZIP 条目结构无效：{e}"))?;
        if entry.encrypted()
            || !matches!(
                entry.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
            || entry
                .data_start()
                .checked_add(entry.compressed_size())
                .is_none_or(|end| end > central)
        {
            return Err("ZIP 条目加密、压缩方式或数据边界无效".into());
        }
    }
    Ok(())
}
