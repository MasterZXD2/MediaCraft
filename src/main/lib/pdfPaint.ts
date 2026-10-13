import sharp from 'sharp'

export async function preparePdfPaintImage(png: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(png, { limitInputPixels: 16_000_000 })
    .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const distances = new Uint16Array(info.width * info.height)
  distances.fill(0xffff)
  let hasPaint = false
  let hasTransparentPixels = false

  // PDF readers may interpolate RGB and the soft mask separately; transparent black creates dark fringes.
  const extendColor = (pixel: number, neighbor: number): void => {
    const distance = distances[neighbor] + 1
    if (distance >= distances[pixel]) return
    distances[pixel] = distance
    const target = pixel * 4
    const source = neighbor * 4
    data[target] = data[source]
    data[target + 1] = data[source + 1]
    data[target + 2] = data[source + 2]
  }

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const pixel = y * info.width + x
      if (data[pixel * 4 + 3] !== 0) {
        distances[pixel] = 0
        hasPaint = true
        continue
      }
      hasTransparentPixels = true
      if (x > 0) extendColor(pixel, pixel - 1)
      if (y > 0) extendColor(pixel, pixel - info.width)
    }
  }
  if (!hasPaint || !hasTransparentPixels) return png

  for (let y = info.height - 1; y >= 0; y--) {
    for (let x = info.width - 1; x >= 0; x--) {
      const pixel = y * info.width + x
      if (distances[pixel] === 0) continue
      if (x + 1 < info.width) extendColor(pixel, pixel + 1)
      if (y + 1 < info.height) extendColor(pixel, pixel + info.width)
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png().toBuffer()
}
