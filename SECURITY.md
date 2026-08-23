# Security Policy

## Reporting
Please report suspected vulnerabilities privately through GitHub Security Advisories or by contacting the maintainers directly. Do not open public issues for exploitable findings.

## Hardening notes
- Keep `.env` files local and out of version control.
- Restrict `CORS_ORIGIN` in production instead of allowing every origin.
- Use the built-in API rate limiter to reduce abuse.
- Review `npm audit` and CodeQL results before releases.
