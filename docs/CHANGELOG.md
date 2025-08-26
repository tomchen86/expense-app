# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Created comprehensive documentation restructure with `/docs` folder
- Added `CLAUDE.md` with development guidelines and 500-line file limit
- Created `/docs/archive/` folder for legacy documentation  
- Established new `ROADMAP.md` with 12-18 month strategic development plan
- Created detailed `PLANNING.md` with immediate action items and weekly execution plan
- Added comprehensive `ARCHITECTURE.md` documenting system architecture and technical patterns
- Created `SESSION_SUMMARY.md` documenting development session and key decisions
- Added documentation standards and change management processes

### Changed
- Moved `CLAUDE.md` from root to `/docs/CLAUDE.md`
- Archived legacy `couples_expense_architecture_roadmap.md` to `/docs/archive/`
- Archived legacy `REFACTORING_PLAN.md` to `/docs/archive/`
- Restructured documentation for better organization and maintenance

### Architecture Documentation Added
- **System Overview**: Current local-only vs. future multi-user architecture diagrams
- **Domain Models**: Complete specifications for Expense, Group, Participant, Category entities
- **App-Specific Patterns**: Mobile (Zustand + React Navigation), API (NestJS), Web (Next.js) architectures
- **Migration Path**: Local-to-server transition strategy with data export/sync patterns
- **Performance & Security**: Scalability considerations and security requirements

### Development Guidelines Established
- **Documentation Standards**: All docs in `/docs` folder with archive system
- **Code Quality**: 500-line file limit with refactoring guidelines  
- **Planning System**: Roadmap for long-term, PLANNING.md for immediate actions
- **Change Tracking**: All significant changes recorded in this changelog

---

## Template for Future Entries

```
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security improvements
```