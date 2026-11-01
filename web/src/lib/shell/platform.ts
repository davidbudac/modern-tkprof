/** The part of `navigator` the platform check reads (`userAgentData` is Chromium only). */
export interface NavigatorLike {
  platform?: string
  userAgentData?: { platform?: string }
}

/** Whether `nav` is macOS: `userAgentData.platform` ("macOS") first, else the older `platform` ("MacIntel"). */
export function macPlatform(nav: NavigatorLike | undefined): boolean {
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '')
}

/** macOS: view chords use ⌘ rather than Ctrl. False outside a browser (tests, server rendering). */
export const isMac: boolean = typeof window !== 'undefined' && typeof navigator !== 'undefined' && macPlatform(navigator as NavigatorLike)
