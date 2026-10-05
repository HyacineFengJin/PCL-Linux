//! Bounded container signature/header checks, rather than a second codec stack.
//! Actual rendering remains in the browser decoder; SVG/HTML/script formats are
//! never admitted. Extensions must agree with the detected container type.
use super::{AssetCollection, AssetKind};

pub(super) fn classify(
    name: &str,
    header: &[u8],
    total: u64,
    collection: AssetCollection,
) -> Result<(AssetKind, &'static str), String> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .ok_or("媒体文件必须有扩展名")?;
    let (kind, mime, valid) = match extension.as_str() {
        "png" => (AssetKind::Image, "image/png", png(header)),
        "jpg" | "jpeg" => (AssetKind::Image, "image/jpeg", jpeg(header)),
        "gif" => (
            AssetKind::Image,
            "image/gif",
            header.len() >= 13
                && matches!(&header[..6], b"GIF87a" | b"GIF89a")
                && dimensions(
                    u16::from_le_bytes([header[6], header[7]]) as u32,
                    u16::from_le_bytes([header[8], header[9]]) as u32,
                ),
        ),
        "webp" => (
            AssetKind::Image,
            "image/webp",
            riff(header, total, b"WEBP")
                && header.len() >= 20
                && matches!(&header[12..16], b"VP8 " | b"VP8L" | b"VP8X"),
        ),
        "mp4" => (AssetKind::Video, "video/mp4", mp4(header, total)),
        "webm" => (AssetKind::Video, "video/webm", webm(header)),
        "mp3" => (AssetKind::Audio, "audio/mpeg", mp3(header, total)),
        "ogg" => (AssetKind::Audio, "audio/ogg", ogg(header)),
        "wav" => (AssetKind::Audio, "audio/wav", wav(header, total)),
        "flac" => (AssetKind::Audio, "audio/flac", flac(header)),
        _ => return Err("该媒体文件格式不受支持".into()),
    };
    if !valid || !collection.accepts(kind) {
        return Err(format!("媒体内容、扩展名或所属目录不匹配：{name}"));
    }
    Ok((kind, mime))
}

pub(super) fn recognized(name: &str, collection: AssetCollection) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match collection {
        AssetCollection::Music => matches!(ext.as_str(), "mp3" | "ogg" | "wav" | "flac"),
        AssetCollection::Titles => matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp"),
        AssetCollection::Backgrounds => matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "mp4" | "webm"
        ),
    }
}
fn dimensions(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= 32768
        && height <= 32768
        && (width as u64) * (height as u64) <= 100_000_000
}
fn png(h: &[u8]) -> bool {
    h.len() >= 33
        && &h[..8] == b"\x89PNG\r\n\x1a\n"
        && h[8..12] == 13u32.to_be_bytes()
        && &h[12..16] == b"IHDR"
        && dimensions(
            u32::from_be_bytes(h[16..20].try_into().unwrap()),
            u32::from_be_bytes(h[20..24].try_into().unwrap()),
        )
        && matches!(h[24], 1 | 2 | 4 | 8 | 16)
        && matches!(h[25], 0 | 2 | 3 | 4 | 6)
        && h[26] == 0
        && h[27] == 0
        && h[28] <= 1
}
fn jpeg(h: &[u8]) -> bool {
    if h.len() < 4 || &h[..2] != b"\xff\xd8" {
        return false;
    }
    let mut position = 2usize;
    while position + 4 <= h.len() {
        if h[position] != 0xff {
            return false;
        }
        let marker = h[position + 1];
        if marker == 0xff {
            position += 1;
            continue;
        }
        if matches!(marker, 0xda | 0xd9) {
            return false;
        }
        let length = u16::from_be_bytes([h[position + 2], h[position + 3]]) as usize;
        if length < 2 || position + 2 + length > h.len() {
            return false;
        }
        if matches!(marker, 0xc0 | 0xc1 | 0xc2) {
            return length >= 8
                && dimensions(
                    u16::from_be_bytes([h[position + 7], h[position + 8]]) as u32,
                    u16::from_be_bytes([h[position + 5], h[position + 6]]) as u32,
                );
        }
        position += length + 2;
    }
    false
}
fn riff(h: &[u8], total: u64, kind: &[u8; 4]) -> bool {
    h.len() >= 12
        && &h[..4] == b"RIFF"
        && &h[8..12] == kind
        && u32::from_le_bytes(h[4..8].try_into().unwrap()) as u64 + 8 == total
}
fn mp4(h: &[u8], total: u64) -> bool {
    if h.len() < 20 || &h[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes(h[..4].try_into().unwrap()) as usize;
    size >= 20
        && size <= 4096
        && size <= h.len()
        && size as u64 <= total
        && (h[8..size].chunks_exact(4).any(|brand| {
            matches!(
                brand,
                b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V "
            )
        }))
}
fn variable(h: &[u8], position: &mut usize, strip: bool) -> Option<u64> {
    let first = *h.get(*position)?;
    let width = first.leading_zeros() as usize + 1;
    if width > 8 || first == 0 {
        return None;
    }
    let mut value = if strip {
        first & if width == 8 { 0 } else { 0xff >> width }
    } else {
        first
    } as u64;
    for offset in 1..width {
        value = (value << 8) | *h.get(*position + offset)? as u64;
    }
    *position += width;
    Some(value)
}
fn webm(h: &[u8]) -> bool {
    if !h.starts_with(b"\x1a\x45\xdf\xa3") {
        return false;
    }
    let mut position = 4;
    let Some(size) = variable(h, &mut position, true) else {
        return false;
    };
    if size > 4096 {
        return false;
    }
    let Some(end) = position
        .checked_add(size as usize)
        .filter(|end| *end <= h.len())
    else {
        return false;
    };
    while position < end {
        let Some(id) = variable(h, &mut position, false) else {
            return false;
        };
        let Some(size) = variable(h, &mut position, true) else {
            return false;
        };
        let Some(next) = position
            .checked_add(size as usize)
            .filter(|next| *next <= end)
        else {
            return false;
        };
        if id == 0x4282 {
            return &h[position..next] == b"webm";
        }
        position = next;
    }
    false
}
fn mp3(h: &[u8], total: u64) -> bool {
    let mut position = 0;
    if h.starts_with(b"ID3") {
        if h.len() < 10 || !(2..=4).contains(&h[3]) || h[6..10].iter().any(|b| b & 0x80 != 0) {
            return false;
        }
        let size = h[6..10]
            .iter()
            .fold(0usize, |size, byte| (size << 7) | *byte as usize);
        position = size + 10;
        if h[5] & 0x10 != 0 {
            position += 10;
        }
        if position as u64 >= total {
            return false;
        }
    }
    let Some(frame) = h.get(position..position + 4) else {
        return false;
    };
    frame[0] == 0xff
        && frame[1] & 0xe0 == 0xe0
        && frame[1] & 0x18 != 0x08
        && frame[1] & 0x06 == 0x02
        && !matches!(frame[2] >> 4, 0 | 15)
        && frame[2] & 0x0c != 0x0c
}
fn ogg(h: &[u8]) -> bool {
    if h.len() < 27 || &h[..4] != b"OggS" || h[4] != 0 || h[5] & 2 == 0 {
        return false;
    }
    let segments = h[26] as usize;
    let start = 27 + segments;
    if start > h.len() {
        return false;
    }
    let size = h[27..start].iter().map(|v| *v as usize).sum::<usize>();
    if start + size > h.len() {
        return false;
    }
    let packet = &h[start..start + size];
    packet.starts_with(b"OpusHead") || packet.starts_with(b"\x01vorbis")
}
fn wav(h: &[u8], total: u64) -> bool {
    if !riff(h, total, b"WAVE") {
        return false;
    }
    let mut position = 12;
    let mut format = false;
    while position + 8 <= h.len() {
        let size = u32::from_le_bytes(h[position + 4..position + 8].try_into().unwrap()) as usize;
        let Some(end) = position.checked_add(8).and_then(|p| p.checked_add(size)) else {
            return false;
        };
        let tag = &h[position..position + 4];
        if tag == b"data" {
            return format && size > 0 && end as u64 <= total;
        }
        if end > h.len() {
            return false;
        }
        if tag == b"fmt " {
            if size < 16 {
                return false;
            }
            let encoding = u16::from_le_bytes([h[position + 8], h[position + 9]]);
            let channels = u16::from_le_bytes([h[position + 10], h[position + 11]]);
            let rate = u32::from_le_bytes(h[position + 12..position + 16].try_into().unwrap());
            format = matches!(encoding, 1 | 3 | 0xfffe)
                && (1..=32).contains(&channels)
                && (8000..=384000).contains(&rate);
        }
        position = end + (size % 2);
    }
    false
}
fn flac(h: &[u8]) -> bool {
    h.len() >= 42
        && &h[..4] == b"fLaC"
        && h[4] & 0x7f == 0
        && h[5..8] == [0, 0, 34]
        && h[18..21].iter().any(|byte| *byte != 0)
}
