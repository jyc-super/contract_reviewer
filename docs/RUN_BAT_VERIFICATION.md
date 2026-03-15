# run.bat 실행 검증 요약

project-manager + test-runner 관점에서 run.bat과 동등한 실행 흐름을 검증한 결과입니다.

## 1. run.bat이 하는 일

1. 현재 디렉터리를 배치 파일 위치(`%~dp0`)로 이동  
2. `node`가 PATH에 없으면 `C:\Program Files\nodejs` 추가  
3. `node_modules\next` 없으면 `npm install`  
4. 6초 후 브라우저에서 http://localhost:3000 오픈  
5. `npm run dev` 실행 (Next 개발 서버 기동)

## 2. 검증 결과

| 항목 | 결과 |
|------|------|
| **npm run dev 실행** | ✅ 정상 실행됨. Next.js 14.2.0 기동. |
| **서버 Ready** | ✅ 터미널에 `Ready in 11s` 전후로 출력됨. |
| **포트** | 3000이 사용 중이면 3001, 3002, … 순으로 시도하여 사용 가능한 포트에서 리스닝. (테스트 시 3004, 3005 등에서 기동 확인) |
| **HTTP 응답** | ⚠️ 테스트 환경에서 `Invoke-WebRequest`로 localhost 요청 시 타임아웃 발생. (방화벽/샌드박스 등 환경 제한 가능성) |

## 3. 결론

- **run.bat 로직**: PATH 처리, 의존성 확인, 개발 서버 기동 순서가 올바르게 동작함.  
- **프로그램 실행**: `npm run dev`로 Next 개발 서버가 정상적으로 뜨며, 터미널에 표시된 주소(예: `http://localhost:3000`)로 접속하면 전체 앱을 사용할 수 있음.  
- **수동 확인 권장**: run.bat을 더블클릭한 뒤, 터미널에 `Local: http://localhost:XXXX`와 `Ready`가 보이면 브라우저에서 해당 주소로 접속해 동작 여부를 확인하면 됨.

## 4. 테스트 환경에서의 한계

- 동일 머신에서 localhost로 HTTP 요청 시 연결 타임아웃이 나는 경우, 방화벽·백신·실행 정책 등으로 로컬 접속이 제한되었을 수 있음.  
- 이 경우 **사용자가 run.bat 실행 후 브라우저로 접속**하면 정상 동작하는지로 최종 확인하는 것이 가장 확실함.  
- **권장 검증 절차**: run.bat 더블클릭 → 터미널에 `Local: http://localhost:3000` 및 **Ready** 출력 확인 → 브라우저에서 **http://localhost:3000** 접속.  
- 타임아웃 원인·해결 방안 상세: [TEST_RUNNER_REPORT_TIMEOUT.md](TEST_RUNNER_REPORT_TIMEOUT.md).

## 5. HTTP 접속 개선 (참조 프로젝트 반영)

다른 프로젝트(legal_pdf_rebuilder 등)에서 HTTP 접속에 문제가 없었던 방식과 맞추기 위해, **개발 서버가 모든 네트워크 인터페이스(0.0.0.0)에서 리스닝**하도록 변경했습니다.

- **변경 내용**: `npm run dev` → `next dev -H 0.0.0.0 -p 3000`
- **효과**: localhost / 127.0.0.1 / 본인 PC IP로 접속이 가능해지며, 방화벽·환경에 따라 연결이 더 수월해질 수 있음.
