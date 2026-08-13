# String Utility Package

Implement a `stringutil` package with the following functions:

## `Reverse(s string) string`

Return the string with all characters reversed. UTF-8 safe (handle multi-byte runes).

- Empty string returns empty string
- Single character returns itself
- "hello" returns "olleh"

## `Capitalize(s string) string`

Return the string with the first character uppercased, rest unchanged.

- Empty string returns empty string
- "hello" returns "Hello"
- "HELLO" returns "HELLO" (already capitalized)

## `TrimSpace(s string) string`

Return the string with leading and trailing whitespace removed.

- "  hello  " returns "hello"
- "" returns ""
- "   " returns ""

## `IsPalindrome(s string) bool`

Return true if the string reads the same forwards and backwards (case-insensitive, whitespace ignored).

- "racecar" returns true
- "A man a plan a canal Panama" returns true
- "hello" returns false
- "" returns true (empty string is palindrome)
