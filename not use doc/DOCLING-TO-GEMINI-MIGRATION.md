# Docling → Gemini PDF 파싱 전환 작업 지시서

> 이 문서는 Cursor(Claude Code)에게 전달하여 Docling 의존성을 제거하고
> Gemini API의 네이티브 PDF 입력 기능으로 대체하는 작업을 수행시키기 위한 지시서입니다.

---

## 배경

### 왜 바꾸는가
- Docling은 Docker 컨테이너로 실행되는 별도 서버임
- Vercel 서버리스 환경에서 Docker를 돌릴 수 없음
- 로컬에 Docker를 설치해야 하는 부담
- Gemini API는 PDF 바이너리를 직접 입력으로 받아 레이아웃 분석이 가능함

### 핵심 원칙
- **Docling 관련 코드와 의존성을 완전히 제거**
- **Gemini의 PDF 네이티브 입력(inlineData + mimeType: 'application/pdf')으로 대체**
- **무료 티어 할당량 안에서 동작하도록 설계**
- **Vercel 배포 가능 (서버리스 호환)**

---

## 1단계: Docling 의존성 제거

### 1-1. 삭제할 파일/코드

```
삭제 대상:
- DOCLING_SERVICE_URL 환경변수 관련 코드 전부
- lib/document-parser.ts 내 callDoclingService() 함수
- Docling 연결 테스트 관련 코드
- docker 관련 안내 UI/문구
```

### 1-2. 삭제할 환경변수

`.env.local`에서 제거:
```diff
- DOCLING_SERVICE_URL=http://localhost:5001
```

### 1-3. 삭제할 패키지 (있다면)

```bash
npm uninstall docling-sdk  # 설치되어 있다면
```

---

## 2단계: Gemini PDF 파싱 구현

### 2-1. 핵심 개념

Gemini API는 PDF 파일을 `inlineData`로 직접 전송할 수 있다.
모델이 PDF를 **네이티브 비전**으로 읽어서 텍스트, 표, 이미지, 레이아웃을 모두 이해한다.

```
기존 (Docling):
  PDF → [Docling Docker 서버] → 구조화된 JSON → 앱

변경 (Gemini):
  PDF → [Gemini API에 PDF 바이너리 직접 전송] → 구조화된 JSON → 앱
```

### 2-2. Gemini PDF 입력 방법 (JavaScript/TypeScript)

#### 방법 A: 인라인 데이터 (20MB 이하 PDF)

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function parsePdfWithGemini(
  pdfBuffer: Buffer,
  prompt: string,
  model: string = "gemini-2.0-flash"
): Promise<string> {
  const genModel = genAI.getGenerativeModel({ model });

  const result = await genModel.generateContent([
    {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBuffer.toString("base64"),
      },
    },
    { text: prompt },
  ]);

  return result.response.text();
}
```

#### 방법 B: Files API (20MB 이상 PDF, 최대 2GB)

```typescript
import { GoogleAIFileManager } from "@google/generative-ai/server";

const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);

async function uploadAndParsePdf(
  filePath: string,
  prompt: string,
  model: string = "gemini-2.0-flash"
): Promise<string> {
  // 1. PDF 업로드 (48시간 보관, 무료)
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: "application/pdf",
    displayName: "contract.pdf",
  });

  // 2. 업로드된 파일 참조로 분석 요청
  const genModel = genAI.getGenerativeModel({ model });
  const result = await genModel.generateContent([
    {
      fileData: {
        mimeType: uploadResult.file.mimeType,
        fileUri: uploadResult.file.uri,
      },
    },
    { text: prompt },
  ]);

  return result.response.text();
}
```

### 2-3. 파일 크기별 전략

```
PDF 크기       방법         비고
─────────────────────────────────────────
< 20MB        인라인(A)     대부분의 계약서
20MB ~ 50MB   Files API(B)  대형 합본 PDF
> 50MB        분할 후 A/B   50MB 초과 시 PDF를 분할
```

---

## 3단계: lib/document-parser.ts 전면 재작성

### 기존 구조 (Docling 기반)

```
processContract(file)
  → callDoclingService(file)     ← 삭제
  → fallback: extractTextByPage(file)  ← 삭제
  → parseDoclingResponse(result)  ← 삭제
```

### 새 구조 (Gemini 기반)

```
processContract(file)
  → uploadPdfToGemini(file)       ← 신규: Files API로 업로드 (대용량 대비)
  → extractDocumentStructure()    ← 신규: 구역 분류 프롬프트
  → extractClausesFromZones()     ← 신규: 조항 분리 프롬프트
  → validateAndCleanup()          ← 신규: 품질 검증
```

### 새 lib/document-parser.ts 핵심 코드

```typescript
// lib/document-parser.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);

// ─── PDF를 Gemini에 전송하는 핵심 함수 ───

async function sendPdfToGemini(
  pdfBuffer: Buffer,
  prompt: string,
  model: string = "gemini-2.0-flash"
): Promise<string> {
  const sizeInMB = pdfBuffer.length / (1024 * 1024);

  if (sizeInMB <= 20) {
    // 인라인 전송
    const genModel = genAI.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });

    const result = await genModel.generateContent([
      {
        inlineData: {
          mimeType: "application/pdf",
          data: pdfBuffer.toString("base64"),
        },
      },
      { text: prompt },
    ]);

    return result.response.text();
  } else {
    // Files API로 업로드 후 전송
    const tempPath = `/tmp/upload-${Date.now()}.pdf`;
    const fs = await import("fs/promises");
    await fs.writeFile(tempPath, pdfBuffer);

    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType: "application/pdf",
      displayName: `contract-${Date.now()}.pdf`,
    });

    await fs.unlink(tempPath); // 임시 파일 삭제

    const genModel = genAI.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });

    const result = await genModel.generateContent([
      {
        fileData: {
          mimeType: uploadResult.file.mimeType,
          fileUri: uploadResult.file.uri,
        },
      },
      { text: prompt },
    ]);

    return result.response.text();
  }
}

// ─── Stage 3: 문서 구역 분류 (Gemini가 PDF를 직접 보고 분류) ───

export async function classifyDocumentZones(
  pdfBuffer: Buffer
): Promise<ZoningResult> {
  const prompt = `You are analyzing a construction contract PDF document.
Look at the ENTIRE document and classify each section into zones.

For each zone, identify:
- zone_type: one of [contract_body, general_conditions, particular_conditions, 
  technical_specification, drawing_list, schedule, bill_of_quantities,
  cover_page, table_of_contents, correspondence, quotation, 
  signature_page, appendix_other, unknown]
- start_page: first page number
- end_page: last page number
- title: detected section title
- is_analysis_target: true if this zone contains contract clauses that need risk analysis
- confidence: 0.0 to 1.0

INCLUDE for analysis: contract body, general conditions, particular conditions, 
amendments, definitions, dispute resolution, payment terms.
EXCLUDE: cover pages, TOC, technical specs, drawings, BOQ, schedules, 
correspondence, quotations.

Respond ONLY in valid JSON. No markdown.
{
  "zones": [...],
  "total_pages": number,
  "warnings": ["any issues found"]
}`;

  const response = await sendPdfToGemini(pdfBuffer, prompt, "gemini-2.0-flash");
  return JSON.parse(response);
}

// ─── Stage 5: 특정 페이지 범위에서 조항 추출 ───

export async function extractClausesFromPages(
  pdfBuffer: Buffer,
  startPage: number,
  endPage: number,
  zoneType: string
): Promise<ParsedClause[]> {
  const prefix = zoneType === "general_conditions" ? "GC"
    : zoneType === "particular_conditions" ? "PC"
    : "MAIN";

  const prompt = `You are extracting individual contract clauses from pages ${startPage} to ${endPage} of this PDF.

For each clause, extract:
- clause_number: the clause/article number (e.g., "14.1", "제3조")
- title: clause title
- content: full clause text
- order_index: sequential order (starting from 0)

Rules:
- Prefix each clause_number with "${prefix}-" (e.g., "${prefix}-14.1")
- Preserve the EXACT original text — do not summarize
- Include sub-clauses as part of their parent clause
- If a section has no clear clause numbering, split by paragraphs and set is_auto_split: true
- IGNORE headers, footers, page numbers — only extract clause content

Respond ONLY in valid JSON. No markdown.
{
  "clauses": [
    {
      "clause_number": "${prefix}-14.1",
      "title": "The Contract Price",
      "content": "full original text...",
      "order_index": 0,
      "is_auto_split": false
    }
  ]
}`;

  const response = await sendPdfToGemini(pdfBuffer, prompt, "gemini-2.0-flash");
  return JSON.parse(response).clauses;
}

// ─── Stage 1+2: 파일 검증 + 기본 정보 추출 ───

export async function extractDocumentMetadata(
  pdfBuffer: Buffer
): Promise<DocumentMetadata> {
  const prompt = `Analyze this PDF and extract basic metadata.
Respond ONLY in valid JSON:
{
  "title": "document title or null",
  "total_pages": number,
  "languages": ["en", "ko"],
  "parties": ["Party A name", "Party B name"] or [],
  "contract_date": "YYYY-MM-DD" or null,
  "has_tables": true/false,
  "has_scanned_pages": true/false,
  "document_type": "contract" | "specification" | "letter" | "mixed" | "unknown"
}`;

  const response = await sendPdfToGemini(pdfBuffer, prompt, "gemma-3-12b-it");
  return JSON.parse(response);
}
```

---

## 4단계: 6단계 전처리 파이프라인 수정

### 기존 vs 새 파이프라인

```
기존 (Docling 사용):                     새 (Gemini PDF 사용):
─────────────────────                   ─────────────────────
1. 파일 검증 (file-type)                 1. 파일 검증 (file-type)
2. Docling에 PDF 전송 → 구조 추출        2. Gemini에 PDF 전송 → 메타데이터 추출
3. LLM으로 구역 분류                      3. Gemini가 PDF를 직접 보고 구역 분류 ★
4. 사용자 확인                           4. 사용자 확인
5. 정규식+LLM 조항 분리                  5. Gemini가 PDF를 직접 보고 조항 추출 ★
6. 품질 검증                             6. 품질 검증

★ = Gemini가 PDF 원본을 직접 보므로 텍스트 추출 단계가 없음
    → 표 깨짐, 머리글 혼입, 순서 뒤섞임 문제가 원천적으로 해결됨
```

### 핵심 차이: 텍스트 추출 단계가 사라짐

Docling 방식은 `PDF → 텍스트 추출 → 텍스트에서 조항 분리`였다.
Gemini 방식은 `PDF → Gemini가 직접 보고 조항 추출`이다.

중간에 텍스트로 변환하는 과정이 없으므로:
- 표가 한 줄로 합쳐지는 문제 → Gemini가 표를 표로 인식
- 머리글이 본문에 섞이는 문제 → Gemini가 머리글을 무시
- 조항 경계가 틀리는 문제 → Gemini가 원본 레이아웃을 보고 판단
- DOCX 서식 소실 문제 → DOCX도 텍스트 변환 없이 직접 전송 가능

---

## 5단계: 할당량 영향 분석 및 모델 배정

### PDF 파싱에 소비되는 할당량

```
작업                         모델              호출 수   RPD 소비
───────────────────────────────────────────────────────────────
메타데이터 추출               Gemma 12B           1      1/14,400
구역 분류 (전체 PDF 1회)     3.1 Flash Lite       1      1/500
조항 추출 (구역당 1회, ~3구역) 3.1 Flash Lite      3      3/500
───────────────────────────────────────────────────────────────
PDF 파싱 소계: 3.1 Flash Lite 4회 + Gemma 1회

기존 Docling 방식 대비: Gemma 5~8회 → 3.1 Flash Lite 4회로 변경
Flash Lite를 4회 추가 소비하지만, Docling Docker가 완전히 사라짐
```

### 수정된 전체 예산 (계약서 1건 = 40조항)

```
작업                        모델              호출   누적 Flash Lite
──────────────────────────────────────────────────────────────
★ PDF 메타데이터             Gemma 12B           1    —
★ PDF 구역 분류              3.1 Flash Lite      1    1/500
★ PDF 조항 추출 (3구역)      3.1 Flash Lite      3    4/500
리스크 분석 (40조항)         3.1 Flash Lite     40    44/500
FIDIC 비교 (40조항)          3.1 Flash Lite     40    84/500
교차 검증 (HIGH만, ~5)       2.5 Flash           5    5/20
임베딩 (40조항)              Embedding          40    40/1,000
──────────────────────────────────────────────────────────────
3.1 Flash Lite 합계: 84회 (기존 80 + PDF 파싱 4)
하루 최대: 500 ÷ 84 ≒ 5.9건 → 약 5건 계약서

Docling 때와 거의 동일한 처리량
```

---

## 6단계: 삭제할 파일 목록

```
삭제:
- lib/parsers/text-extractor.ts      ← Gemini가 직접 PDF를 읽으므로 불필요
- Docling 관련 설정/연결 코드

대폭 수정:
- lib/document-parser.ts             ← callDoclingService → sendPdfToGemini
- lib/parsers/document-zoner.ts      ← 규칙 기반 제거, Gemini PDF 직접 분류
- lib/parsers/clause-splitter.ts     ← 정규식 제거, Gemini PDF 직접 추출

수정:
- app/api/contracts/route.ts         ← 전처리 흐름 변경
- components/upload/UploadProgress   ← Stage 2 설명 변경 (텍스트 추출 → PDF 분석)
- .env.local                         ← DOCLING_SERVICE_URL 제거

유지:
- lib/parsers/file-validator.ts      ← 파일 크기/타입 검증은 그대로
- lib/parsers/quality-checker.ts     ← 품질 검증은 그대로
- lib/parsers/zone-filter.ts         ← 사용자 확인 로직은 그대로
```

---

## 7단계: DOCX 처리

Gemini는 DOCX도 직접 처리할 수 있다. 다만 현재 API에서 DOCX를 inlineData로 보내는 것은 PDF만큼 안정적이지 않을 수 있다.

### 권장 전략

```
DOCX 파일 업로드 시:
  1. mammoth으로 DOCX → HTML 변환 (기존 코드 유지)
  2. HTML을 텍스트로 변환
  3. 텍스트를 Gemini에 전송하여 조항 분리
  
  또는
  
  1. libreoffice 등으로 DOCX → PDF 변환
  2. 변환된 PDF를 Gemini에 전송 (PDF 파이프라인 재활용)
```

mammoth은 npm 패키지이므로 Vercel에서도 동작한다. DOCX 처리에는 mammoth을 유지하는 것이 안전하다.

---

## 8단계: 환경변수 최종 정리

```bash
# .env.local — Docling 제거 후 최종

# Supabase (로컬 또는 클라우드)
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...

# Gemini API (유일한 외부 서비스)
GEMINI_API_KEY=AIzaSy...

# Docling — 삭제됨
# DOCLING_SERVICE_URL= ← 이 줄 제거
```

---

## 9단계: 패키지 정리

```bash
# 삭제
npm uninstall docling-sdk    # 있다면

# 유지
# @google/generative-ai      ← Gemini SDK (이미 사용 중)
# mammoth                     ← DOCX 처리용 (유지)
# file-type                   ← MIME 검증용 (유지)
# franc                       ← 언어 감지용 (유지)

# 추가 (필요 시)
npm install @google/generative-ai  # 최신 버전으로 업데이트
```

---

## 10단계: 테스트 체크리스트

구현 후 확인할 항목:

- [ ] PDF 업로드 → 구역 분류가 JSON으로 정상 반환되는지
- [ ] 표가 포함된 PDF → 표 내용이 정상 추출되는지
- [ ] 머리글/바닥글 → 조항 본문에 섞이지 않는지
- [ ] 조항 번호 → 정확하게 분리되는지 (GC-14.1, PC-14.2 등)
- [ ] 100페이지+ 대용량 PDF → Files API로 정상 업로드되는지
- [ ] DOCX → mammoth으로 정상 변환되는지
- [ ] 할당량 → 계약서 1건에 Flash Lite ~84회 소비하는지
- [ ] 429 에러 → 재시도/폴백이 정상 동작하는지
- [ ] DOCLING_SERVICE_URL 참조 → 코드 전체에서 완전히 제거되었는지
- [ ] Vercel 배포 → 서버리스 함수에서 PDF 파싱이 정상 동작하는지

---

## 요약

| 항목 | 변경 전 (Docling) | 변경 후 (Gemini) |
|------|-------------------|-----------------|
| PDF 파싱 | Docling Docker 서버 | Gemini API 직접 전송 |
| 설치 필요 | Docker 필수 | 없음 |
| Vercel 배포 | ❌ | ✅ |
| 추가 비용 | 0원 (로컬) | 0원 (무료 API) |
| 할당량 영향 | 없음 | +4 Flash Lite/건 |
| 하루 처리량 | ~6건 | ~5건 (거의 동일) |
| 표 인식 | TableFormer AI | Gemini 네이티브 비전 |
| 머리글 분리 | DocLayNet AI | Gemini 네이티브 비전 |
| DOCX 처리 | Docling 네이티브 | mammoth (기존 유지) |
