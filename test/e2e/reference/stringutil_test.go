package stringutil_test

import (
	"strings"
	"testing"

	"stringutil"
)

func TestReverse(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty string", "", ""},
		{"single char", "a", "a"},
		{"hello", "hello", "olleh"},
		{"even length", "ab", "ba"},
		{"UTF-8 emoji", "👋world", "dlrow👋"},
		{"mixed UTF-8", "你好世界", "界世好你"},
		{"spaces", "  hello  ", "  olleh  "},
		{"numbers", "12345", "54321"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := stringutil.Reverse(tt.input)
			if result != tt.expected {
				t.Errorf("Reverse(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestCapitalize(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"empty string", "", ""},
		{"hello", "hello", "Hello"},
		{"HELLO", "HELLO", "HELLO"},
		{"single char", "a", "A"},
		{"already capitalized", "Hello", "Hello"},
		{"number first", "1abc", "1abc"},
		{"uppercase input", "WORLD", "WORLD"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := stringutil.Capitalize(tt.input)
			if result != tt.expected {
				t.Errorf("Capitalize(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestTrimSpace(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"spaces", "  hello  ", "hello"},
		{"empty string", "", ""},
		{"all spaces", "   ", ""},
		{"tabs and newlines", "\t\nhello\t\n", "hello"},
		{"no spaces", "hello", "hello"},
		{"internal spaces", "  hello world  ", "hello world"},
		{"single space", " ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := stringutil.TrimSpace(tt.input)
			if result != tt.expected {
				t.Errorf("TrimSpace(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestIsPalindrome(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{"racecar", "racecar", true},
		{"case insensitive", "RaceCar", true},
		{"with spaces", "A man a plan a canal Panama", true},
		{"hello", "hello", false},
		{"empty string", "", true},
		{"single char", "a", true},
		{"all spaces", "   ", true},
		{"tabs and mixed", "\tRa ce caR\t", true},
		{"unicode", "你好", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := stringutil.IsPalindrome(tt.input)
			if result != tt.expected {
				t.Errorf("IsPalindrome(%q) = %v, want %v", tt.input, result, tt.expected)
			}
		})
	}
}

func BenchmarkReverse(b *testing.B) {
	for i := 0; i < b.N; i++ {
		stringutil.Reverse("hello world")
	}
}

func BenchmarkCapitalize(b *testing.B) {
	for i := 0; i < b.N; i++ {
		stringutil.Capitalize("hello world")
	}
}

func BenchmarkIsPalindrome(b *testing.B) {
	for i := 0; i < b.N; i++ {
		stringutil.IsPalindrome("A man a plan a canal Panama")
	}
}

// Verify strings package is used (coverage check)
var _ = strings.TrimSpace
