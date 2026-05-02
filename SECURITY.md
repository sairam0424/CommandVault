# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | ✅ Current         |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public issue
2. Email **nothumanslabs@gmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive a response within 48 hours
4. We will coordinate a fix and disclosure timeline

## Security Measures

- All SQL queries use parameterized statements
- HTML content is escaped to prevent XSS
- VS Code webviews use nonce-based CSP
- File paths are validated to prevent traversal
- SSRF protection on URL imports (HTTPS-only, private IP blocking)
- Dependencies audited weekly via Dependabot
