//! Decode one bounded static PNG and crop the Minecraft front-head regions.
//! Nearest-neighbour resizing preserves skin pixels. The base face is opaque as
//! in Minecraft; legacy opaque upper-right padding disables its unused hat layer,
//! while a modern opaque overlay remains visible.
use std::io::{self, Cursor, Write};
pub(super) struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
const DECODED_LIMIT: usize = 16 * 1024 * 1024;
const PNG_LIMIT: usize = 8 * 1024 * 1024;
fn chunks(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > PNG_LIMIT || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("图片不是受支持的 PNG 文件".into());
    }
    let mut offset = 8usize;
    let mut count = 0usize;
    loop {
        let header = bytes.get(offset..offset + 8).ok_or("PNG 数据不完整")?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let kind = &header[4..8];
        count += 1;
        if count > 4096
            || count == 1 && (kind != b"IHDR" || length != 13)
            || count > 1 && kind == b"IHDR"
        {
            return Err("PNG 结构不受支持".into());
        }
        if matches!(kind, b"acTL" | b"fcTL" | b"fdAT") {
            return Err("只支持单张静态 PNG 图片".into());
        }
        offset = offset
            .checked_add(length)
            .and_then(|v| v.checked_add(12))
            .filter(|v| *v <= bytes.len())
            .ok_or("PNG 数据不完整")?;
        if kind == b"IEND" {
            return if length == 0 && offset == bytes.len() {
                Ok(())
            } else {
                Err("PNG 结尾含有额外数据".into())
            };
        }
    }
}
pub(super) fn decode(bytes: &[u8]) -> Result<Pixels, String> {
    chunks(bytes)?;
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: 32 * 1024 * 1024,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "PNG 头部无效或超过解码上限")?;
    let info = reader.info();
    let width = info.width;
    let height = info.height;
    if width == 0
        || height == 0
        || width > 2048
        || height > 2048
        || u64::from(width) * u64::from(height) * 4 > DECODED_LIMIT as u64
        || info.animation_control.is_some()
    {
        return Err("PNG 尺寸超过 2048×2048 或不是单张图片".into());
    }
    let required = reader.output_buffer_size();
    if required > DECODED_LIMIT {
        return Err("PNG 解码超过 16 MiB 上限".into());
    }
    let mut source = vec![0; required];
    let frame = reader
        .next_frame(&mut source)
        .map_err(|_| "PNG 像素数据无效")?;
    reader.finish().map_err(|_| "PNG 结尾或校验无效")?;
    let channels = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => return Err("PNG 色彩格式不受支持".into()),
    };
    if frame.bit_depth != png::BitDepth::Eight
        || frame.buffer_size() != width as usize * height as usize * channels
    {
        return Err("PNG 像素长度无效".into());
    }
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for pixel in source[..frame.buffer_size()].chunks_exact(channels) {
        match channels {
            1 => rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], 255]),
            2 => rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]),
            3 => rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]),
            4 => rgba.extend_from_slice(pixel),
            _ => unreachable!(),
        }
    }
    Ok(Pixels {
        width,
        height,
        rgba,
    })
}
pub(super) fn encode(image: &Pixels) -> Result<Vec<u8>, String> {
    // Incompressible canvas pixels can encode larger than the input PNG. Refuse
    // before growing beyond the publication bound, including ancillary framing.
    struct Output(Vec<u8>);
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > PNG_LIMIT.saturating_sub(self.0.len()) {
                return Err(io::Error::other("encoded PNG exceeds limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = Output(Vec::new());
    {
        let mut encoder = png::Encoder::new(&mut bytes, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| "无法编码 PNG 图片")?;
        writer
            .write_image_data(&image.rgba)
            .map_err(|_| "无法编码 PNG 图片")?;
        writer.finish().map_err(|_| "无法完成 PNG 图片")?;
    }
    Ok(bytes.0)
}
pub(super) fn skin_dimensions(image: &Pixels) -> Result<u32, String> {
    if image.width % 64 != 0
        || image.width < 64
        || image.width > 2048
        || !(image.height == image.width || image.height * 2 == image.width)
    {
        return Err("皮肤应为 64×64、64×32 或其整数倍 PNG（最大 2048）".into());
    }
    Ok(image.width / 64)
}
pub(super) fn head(image: &Pixels, size: u32) -> Result<Pixels, String> {
    if !(8..=512).contains(&size) {
        return Err("头像尺寸应为 8–512 像素".into());
    }
    let scale = skin_dimensions(image)?;
    let pixel = |x: u32, y: u32| {
        let start = ((y * image.width + x) * 4) as usize;
        &image.rgba[start..start + 4]
    };
    let legacy = image.height * 2 == image.width;
    let unused_legacy_hat =
        legacy && (0..32 * scale).all(|y| (32 * scale..64 * scale).all(|x| pixel(x, y)[3] >= 128));
    let face = 8 * scale;
    let mut rgba = Vec::with_capacity(size as usize * size as usize * 4);
    for y in 0..size {
        for x in 0..size {
            let sx = x * face / size;
            let sy = y * face / size;
            let base = pixel(8 * scale + sx, 8 * scale + sy);
            let hat = pixel(40 * scale + sx, 8 * scale + sy);
            let alpha = if unused_legacy_hat {
                0
            } else {
                u32::from(hat[3])
            };
            for channel in 0..3 {
                rgba.push(
                    ((u32::from(hat[channel]) * alpha
                        + u32::from(base[channel]) * (255 - alpha)
                        + 127)
                        / 255) as u8,
                );
            }
            rgba.push(255);
        }
    }
    Ok(Pixels {
        width: size,
        height: size,
        rgba,
    })
}
