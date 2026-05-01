---
description: Enforce secure coding practices across the project
keywords:
  - security
  - validation
---

# Security Rules

Always validate user input before processing.

## Requirements

- Use parameterized queries for all database access
- Sanitize HTML output to prevent XSS
- Never hardcode secrets in source files
