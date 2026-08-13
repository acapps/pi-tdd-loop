package stringutil

import (
	"strings"
	"unicode"
)

// Reverse returns the string with all characters reversed.
// UTF-8 safe — handles multi-byte runes correctly.
func Reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}

// Capitalize returns the string with the first character uppercased, rest unchanged.
func Capitalize(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

// TrimSpace returns the string with leading and trailing whitespace removed.
func TrimSpace(s string) string {
	return strings.TrimSpace(s)
}

// IsPalindrome returns true if the string reads the same forwards and backwards.
// Case-insensitive, whitespace ignored.
func IsPalindrome(s string) bool {
	// Normalize: lowercase and remove whitespace
	clean := strings.Builder{}
	for _, r := range s {
		if !unicode.IsSpace(r) {
			clean.WriteRune(unicode.ToLower(r))
		}
	}
	text := clean.String()

	// Check palindrome
	runes := []rune(text)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		if runes[i] != runes[j] {
			return false
		}
	}
	return true
}
