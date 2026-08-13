# String Utility Package

Implement a `stringutil` package with the following functions:

## `Reverse(s string) string`

Return the string with all characters reversed. Must be UTF-8 safe — handle multi-byte runes correctly.

Examples:
- `Reverse("")` returns `""`
- `Reverse("a")` returns `"a"`
- `Reverse("hello")` returns `"olleh"`
- `Reverse("👋world")` returns `"dlrow👋"`

## `Capitalize(s string) string`

Return the string with the first character uppercased, rest unchanged.

Examples:
- `Capitalize("")` returns `""`
- `Capitalize("hello")` returns `"Hello"`
- `Capitalize("HELLO")` returns `"HELLO"`
- `Capitalize("a")` returns `"A"`

## `TrimSpace(s string) string`

Return the string with leading and trailing whitespace removed.

Examples:
- `TrimSpace("  hello  ")` returns `"hello"`
- `TrimSpace("")` returns `""`
- `TrimSpace("   ")` returns `""`
- `TrimSpace("\t\nhello\t\n")` returns `"hello"`

## `IsPalindrome(s string) bool`

Return true if the string reads the same forwards and backwards. Case-insensitive, whitespace ignored.

Examples:
- `IsPalindrome("racecar")` returns `true`
- `IsPalindrome("A man a plan a canal Panama")` returns `true`
- `IsPalindrome("hello")` returns `false`
- `IsPalindrome("")` returns `true`
