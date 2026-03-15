---
name: WSL2 Docker Desktop IP 자동 감지
description: scripts/ensure-local-env.js가 WSL2 IP를 자동 감지하여 .env.local의 Supabase URL을 갱신
type: project
---

`scripts/ensure-local-env.js`가 `npm run dev` 실행 시 WSL2 Docker Desktop IP를 자동 감지하여 `.env.local`의 `NEXT_PUBLIC_SUPABASE_URL`을 자동 갱신.

**Why:** Windows Docker Desktop이 WSL2 백엔드를 사용할 경우, `127.0.0.1`로는 Supabase 컨테이너에 접근 불가. WSL2 eth0 IP가 매 부팅 시 변경될 수 있어 수동 관리 불가능.

**How to apply:** Supabase URL을 수동으로 하드코딩하지 말 것. ensure-local-env.js가 자동 처리함. CLAUDE.md 아키텍처 제약 #7로 명시됨.
