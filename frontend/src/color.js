export function hashString(str) {
  let hash = 5381
  for (let i = 0; i < (str || '').length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash | 0
  }
  return Math.abs(hash)
}

export function colorForKey(key) {
  const h = hashString(String(key)) % 360
  const s = 75
  const l = 55
  return `hsl(${h} ${s}% ${l}%)`
}


