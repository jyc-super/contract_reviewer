# Document AI Expert Memory Index

- [project_parsing_architecture.md](project_parsing_architecture.md) — Complete map of parsing pipeline: active sidecar path, connected layout module status, P0/P1 improvements applied 2026-03-14
- [project_phase4_sub_documents.md](project_phase4_sub_documents.md) — Phase 4A/4B multi-document boundary detection: SubDocument type, 5-signal detection algorithm, migration 008, all affected files.
- [project_sidecar_bugfixes.md](project_sidecar_bugfixes.md) — Comprehensive parse quality bug fixes applied 2026-03-14 to scripts/docling_sidecar.py: heading detection, zone classification, header/footer ratios, TOC level inference via numbering patterns, scan PDF detection, FIDIC patterns, Korean 제N조 clause numbering
- [parsing_quality_qnlp_epc.md](parsing_quality_qnlp_epc.md) — QNLP.ITB.P2 EPC Contract.pdf 파싱 품질 분석 v1+v2. v1: preamble/bracket/Article 버그 6개 수정. v2 (2026-03-14): 6 Task 구현 - parent-child heading 병합 방지, FIDIC 인라인 참조 필터, 단일 번호 heading 패턴, body continuation 필터. 결과: 누락 조항 15개 복구, 거짓 heading 7->0, 중복 22->18, 리그레션 0
- [deep_numbering_and_subitems.md](deep_numbering_and_subitems.md) — 1.1.1.x 4단계 조항 누락 및 (a)(b)(c) 서브아이템 미중첩 근본 원인 분석 (2026-03-14): Phase 3.5 200자 병합 threshold, STRUCT_HEADING_PATTERNS (a) 미매칭, sectionsToClauses() flat 구조 한계
- [fragmented_heading_merge.md](fragmented_heading_merge.md) — PDF에서 "1.1" / "Definitions" 별도 줄 추출 시 heading-only 섹션 중복 생성 버그, _merge_fragmented_headings() Phase 5 후처리로 수정 (2026-03-14)
- [project_bold_preservation.md](project_bold_preservation.md) — 볼드 텍스트 보존 기능 구현 (2026-03-14): pdfplumber chars 기반 apply_bold_markdown(), Docling TextItem/ListItem export_to_markdown() 적용, content_format 필드 전체 파이프라인 추가, migration 010
