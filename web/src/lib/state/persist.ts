import { useEffect, useState } from 'react'

/** useState mirrored into localStorage (silently in memory only when storage is unavailable). */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch { return initial }
  })
  useEffect(() => {
    try {
      if (value === initial || value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value))
    } catch { /* storage unavailable */ }
  }, [key, value, initial])
  return [value, setValue]
}
