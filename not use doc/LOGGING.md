# 실행 로그 (Logger)

프로그램 실행 중 발생하는 오류·경고를 파일에 기록해 두고, 로그를 보고 수정할 수 있도록 합니다.

## 로그 파일 위치

- **경로**: 프로젝트 루트의 `logs/app.log`
- 서버(API 라우트·파이프라인 등)에서 발생한 오류와 클라이언트에서 전송한 오류가 함께 기록됩니다.
- `logs/` 폴더는 실행 중 자동 생성되며, `.gitignore`에 포함되어 커밋되지 않습니다.

## 로그 형식

한 줄 예시:

```
[2025-03-05T12:00:00.000Z] [ERROR] 계약 분석 중 오류 Error: ...
  at ...
```

- `[ISO 타임스탬프] [LEVEL] 메시지` 뒤에 선택적으로 상세(Error인 경우 stack, 객체인 경우 JSON)가 이어집니다.
- 레벨: `ERROR`, `WARN`, `INFO`, `DEBUG`

## 사용처

- **API 라우트**: `app/api/contracts/`, `app/api/contracts/[id]/analyze`, `app/api/contracts/[id]/zones` 등에서 예외 발생 시 `logger.error()` 호출
- **에러 바운더리**: `app/error.tsx`에서 클라이언트 오류 발생 시 `POST /api/log`로 전송 → 서버에서 `logs/app.log`에 기록

## 코드에서 로거 사용

서버 코드(API, lib)에서만 사용합니다.

```ts
import * as logger from "@/lib/logger";

// 오류 (예외 객체 포함)
logger.error("설명 메시지", err);

// 경고
logger.warn("경고 메시지", { key: "value" });

// 정보
logger.info("정보 메시지");
```

## 로그 확인 후 수정

1. `logs/app.log` 파일을 엽니다.
2. `[ERROR]` 줄을 찾아 메시지와 스택 트레이스를 확인합니다.
3. 해당 스택의 파일·라인과 메시지에 맞춰 원인(환경 변수, DB, 외부 API 등)을 파악하고 코드나 설정을 수정합니다.
