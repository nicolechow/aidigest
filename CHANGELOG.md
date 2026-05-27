# Changelog

## 2026-05-27

### Changed
- **X/Twitter**: 从官方 API（需要 $100/月）换成 `agent-twitter-client`，用 Twitter 账号登录抓取，不再需要 `X_BEARER_TOKEN`
  - 新增 Secrets：`TWITTER_USERNAME`、`TWITTER_PASSWORD`、`TWITTER_EMAIL`

## 2026-05-24

### Added
- **新播客来源**：Lenny's Podcast（YouTube `@LennysPodcast`）
- **新播客来源**：自习室 STUDY ROOM（喜马拉雅 RSS，Deepgram 转录）

### Changed
- **播客转录**：移除 pod2txt（服务已停止），改为双路径
  - YouTube 播客 → 直接抓 YouTube 免费字幕
  - 非 YouTube 播客（小宇宙等）→ Deepgram 转录
  - 新增 Secret：`DEEPGRAM_API_KEY`，移除 `POD2TXT_API_KEY`

### Fixed
- `Generate Feeds` workflow 每天失败的问题：pod2txt key 未设置导致脚本直接 exit，现已移除强制退出逻辑
