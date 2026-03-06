"use client";

import { useEffect, useState, useRef } from "react";
import { GeminiKeySetup } from "../../components/dashboard/GeminiKeySetup";

interface StatusRes {
  supabaseConfigured: boolean;
  supabaseDetail: string;
  doclingConfigured: boolean;
  doclingDetail: string;
  geminiConfigured: boolean;
  allOk: boolean;
}

interface QuotaRes {
  resetAt: string;
  estimatedAdditionalContracts: number;
  flash31Lite: { used: number; limit: number; remaining: number };
  flash25: { used: number; limit: number };
  flash25Lite: { used: number; limit: number };
  flash3: { used: number; limit: number };
  gemma27b: { used: number; limit: number };
  gemma12b: { used: number; limit: number };
  gemma4b: { used: number; limit: number };
  embedding: { used: number; limit: number; remaining: number };
}

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusRes | null>(null);
  const [quota, setQuota] = useState<QuotaRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const helpGemini = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/settings/status").then((r) => r.json()),
      fetch("/api/quota").then((r) => r.json()),
    ])
      .then(([s, q]) => {
        setStatus(s as StatusRes);
        setQuota(q as QuotaRes);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const toggleHelp = () => {
    helpGemini.current?.classList.toggle("open");
  };

  const testConnection = () => {
    setTestMsg(null);
    fetch("/api/settings/status")
      .then((r) => r.json())
      .then((s: StatusRes) => {
        if (s.geminiConfigured) {
          setTestMsg({
            ok: true,
            text: "✓ Gemini 연결 성공 — 무료 티어 확인\n3.1 Flash Lite: 500 RPD · 2.5 Flash: 20 RPD · Gemma 27B: 14,400 RPD · Embedding: 1,000 RPD",
          });
        } else {
          setTestMsg({ ok: false, text: "Gemini API 키를 먼저 저장해 주세요." });
        }
      })
      .catch(() => setTestMsg({ ok: false, text: "연결 확인 중 오류가 발생했습니다." }));
  };

  if (loading && !status) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">설정</h1>
          <p className="page-subtitle">로딩 중…</p>
        </header>
        <div className="page-body">
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>로딩 중…</p>
        </div>
      </div>
    );
  }

  const supabaseOk = status?.supabaseConfigured ?? false;
  const doclingOk = status?.doclingConfigured ?? false;
  const geminiOk = status?.geminiConfigured ?? false;
  const anyServiceDown = !supabaseOk || !doclingOk;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">설정</h1>
        <p className="page-subtitle">
          Gemini API 키만 입력하면 됩니다 — 나머지는 로컬에서 자동 실행됩니다
        </p>
      </header>
      <div className="page-body" style={{ maxWidth: 800 }}>
        {/* Status Summary — 순서: Supabase, Docling, Gemini (샘플 (1) 그대로) */}
        <div className="env-summary">
          <div className="env-item">
            <span className={`dot ${supabaseOk ? "dot-ok" : "dot-fail"}`} />
            <strong>Supabase</strong>
            <span style={{ color: supabaseOk ? "var(--accent-green)" : "var(--accent-red)", fontSize: 12 }}>
              {supabaseOk ? "로컬 실행 중" : "미설정"}
            </span>
          </div>
          <div className="env-item">
            <span className={`dot ${doclingOk ? "dot-ok" : "dot-fail"}`} />
            <strong>Docling</strong>
            <span style={{ color: doclingOk ? "var(--accent-green)" : "var(--accent-red)", fontSize: 12 }}>
              {doclingOk ? "로컬 실행 중" : status?.doclingDetail ?? "미설정"}
            </span>
          </div>
          <div className="env-item">
            <span className={`dot ${geminiOk ? "dot-ok" : "dot-fail"}`} />
            <strong>Gemini API</strong>
            <span style={{ color: geminiOk ? "var(--accent-green)" : "var(--accent-red)", fontSize: 12 }}>
              {geminiOk ? "연결됨" : "미설정"}
            </span>
          </div>
          {status?.allOk && (
            <div className="env-item" style={{ marginLeft: "auto", color: "var(--accent-green)", fontSize: 12, fontWeight: 600 }}>
              ✓ 모든 서비스 정상
            </div>
          )}
        </div>

        {/* ===== GEMINI API — 유일한 사용자 입력 (SETUP-GUIDE Step 4) ===== */}
        <div className="section">
          <div className="section-header">
            <div>
              <div className="section-title">
                <span style={{ fontSize: 20 }}>🤖</span> Gemini API Key
              </div>
              <div className="section-desc">
                유일하게 직접 입력이 필요한 항목입니다 — 한 번 저장하면 영구 유지
              </div>
            </div>
            <span className={`status-badge ${geminiOk ? "status-ok" : "status-fail"}`}>
              {geminiOk ? "✓ 연결됨" : "미연결"}
            </span>
          </div>
          <div className="card">
            <div className="card-body">
              <GeminiKeySetup />
              <div className="btn-row">
                <button type="button" className="btn btn-outline" onClick={testConnection} style={{ fontSize: 12 }}>
                  🔌 연결 테스트
                </button>
              </div>
              {testMsg && (
                <div
                  className={`test-result show ${testMsg.ok ? "test-ok" : "test-fail"}`}
                  style={{ whiteSpace: "pre-line" }}
                >
                  {testMsg.text}
                </div>
              )}
              <div className="help-toggle" onClick={toggleHelp}>
                📖 API 키 발급 방법 (3단계, 2분) ▾
              </div>
              <div ref={helpGemini} className="help-box" id="help-gemini">
                <ol>
                  <li>
                    <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-blue)" }}>
                      aistudio.google.com
                    </a>
                    {" "}접속 → Google 계정 로그인
                  </li>
                  <li>왼쪽 메뉴 <strong>Get API Key</strong> → <strong>Create API Key</strong> 클릭</li>
                  <li>생성된 키(<code>AIzaSy...</code>)를 위 입력란에 붙여넣기 → 저장</li>
                </ol>
                <div className="info-box info-blue" style={{ marginTop: 8 }}>
                  💡 무료 티어로 하루 약 6건 계약서(40조항 기준) 분석 가능. 할당량은 매일 17:00 KST에 리셋됩니다.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="divider" />

        {/* ===== 로컬 서비스 상태 (SETUP-GUIDE Step 1: Docker) ===== */}
        <div className="section">
          <div className="section-header">
            <div>
              <div className="section-title">
                <span style={{ fontSize: 20 }}>🖥️</span> 로컬 서비스 상태
              </div>
              <div className="section-desc">
                Docker에서 자동 실행됩니다 — 직접 설정할 필요 없습니다
              </div>
            </div>
            <button type="button" className="btn btn-outline" style={{ fontSize: 12 }} onClick={load}>
              ↻ 새로고침
            </button>
          </div>
          <div className="card">
            <div className="card-body">
              <div className="sys-grid">
                <div className="sys-item">
                  <div className="sys-label">Supabase (로컬 DB)</div>
                  <div className="sys-val">
                    <span className={`dot ${supabaseOk ? "dot-ok" : "dot-fail"}`} />
                    <span style={{ color: supabaseOk ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {supabaseOk ? "실행 중" : "미설정"}
                    </span>
                  </div>
                  <div className="sys-detail">localhost:54321</div>
                  <div className="sys-detail">{supabaseOk ? "7 tables · pgvector ✓" : "npx supabase start"}</div>
                </div>
                <div className="sys-item">
                  <div className="sys-label">Docling (문서 파싱)</div>
                  <div className="sys-val">
                    <span className={`dot ${doclingOk ? "dot-ok" : "dot-fail"}`} />
                    <span style={{ color: doclingOk ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {doclingOk ? "실행 중" : "미설정"}
                    </span>
                  </div>
                  <div className="sys-detail">localhost:5001</div>
                  <div className="sys-detail">{doclingOk ? "TableFormer ✓" : "docker start docling"}</div>
                </div>
                <div className="sys-item">
                  <div className="sys-label">Supabase Studio</div>
                  <div className="sys-val">
                    <span className={`dot ${supabaseOk ? "dot-ok" : "dot-fail"}`} />
                    <span style={{ color: supabaseOk ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {supabaseOk ? "접속 가능" : "미실행"}
                    </span>
                  </div>
                  <div className="sys-detail">localhost:54323</div>
                  <div className="sys-detail">DB 관리 대시보드</div>
                </div>
              </div>

              {anyServiceDown && (
                <div className="info-box info-yellow" style={{ marginTop: 16 }}>
                  ⚠️ 로컬 서비스가 감지되지 않습니다. 프로젝트 루트에서 아래 명령을 실행하세요 (SETUP-GUIDE Step 1):
                  <pre
                    style={{
                      background: "var(--bg-primary)",
                      padding: "10px 14px",
                      borderRadius: 6,
                      margin: "8px 0",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      color: "var(--accent-green)",
                      overflowX: "auto",
                    }}
                  >
                    {`npx supabase start     # Supabase 로컬 실행
docker start docling   # Docling 실행`}
                  </pre>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    최초 1회: <code>npx supabase init</code> 후 <code>npx supabase start</code>, Docling은 <code>docker run -d --name docling -p 5001:5001 --restart unless-stopped quay.io/docling-project/docling-serve</code>
                  </span>
                </div>
              )}

              <div className="info-box info-blue" style={{ marginTop: 16 }}>
                💡 <code>supabase start</code>와 Docling Docker는 <code>--restart unless-stopped</code> 설정으로
                Docker Desktop 시작 시 자동으로 켜집니다. 별도 조작이 필요 없습니다.
              </div>
            </div>
          </div>
        </div>

        <div className="divider" />

        {/* ===== API 할당량 (SETUP-GUIDE 무료 한도) ===== */}
        <div className="section">
          <div className="section-header">
            <div>
              <div className="section-title">
                <span style={{ fontSize: 20 }}>📊</span> API 할당량
              </div>
              <div className="section-desc">Gemini 무료 티어 일일 사용량 — 매일 17:00 KST 리셋</div>
            </div>
          </div>
          <div className="card">
            <div className="card-body">
              {quota ? (
                <>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "var(--text-muted)" }}>모델</th>
                        <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "var(--text-muted)" }}>역할</th>
                        <th style={{ padding: "10px 12px", textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "var(--text-muted)" }}>RPD</th>
                        <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "var(--text-muted)" }}>오늘 사용</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "var(--accent-blue)" }}>3.1 Flash Lite</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-secondary)" }}>★ 핵심 분석</td>
                        <td style={{ padding: "10px 12px", textAlign: "center", fontFamily: "JetBrains Mono, monospace", fontWeight: 700 }}>500</td>
                        <td style={{ padding: "10px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: "var(--bg-primary)", borderRadius: 3, overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${Math.min(100, ((quota.flash31Lite?.used ?? 0) / (quota.flash31Lite?.limit || 1)) * 100)}%`,
                                  height: "100%",
                                  background: "var(--accent-green)",
                                  borderRadius: 3,
                                }}
                              />
                            </div>
                            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--text-secondary)", minWidth: 55, textAlign: "right" }}>
                              {quota.flash31Lite?.used ?? 0}/{quota.flash31Lite?.limit ?? 500}
                            </span>
                          </div>
                        </td>
                      </tr>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>2.5 Flash</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-muted)" }}>교차 검증</td>
                        <td style={{ padding: "10px 12px", textAlign: "center", fontFamily: "JetBrains Mono, monospace" }}>20</td>
                        <td style={{ padding: "10px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: "var(--bg-primary)", borderRadius: 3, overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${Math.min(100, ((quota.flash25?.used ?? 0) / (quota.flash25?.limit || 1)) * 100)}%`,
                                  height: "100%",
                                  background: "var(--accent-yellow)",
                                  borderRadius: 3,
                                }}
                              />
                            </div>
                            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--text-secondary)", minWidth: 55, textAlign: "right" }}>
                              {quota.flash25?.used ?? 0}/{quota.flash25?.limit ?? 20}
                            </span>
                          </div>
                        </td>
                      </tr>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>Gemma 27B</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-muted)" }}>전처리·분류</td>
                        <td style={{ padding: "10px 12px", textAlign: "center", fontFamily: "JetBrains Mono, monospace" }}>14,400</td>
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--text-secondary)" }}>
                            {quota.gemma27b?.used ?? 0}/14.4K
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td style={{ padding: "10px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>Embedding</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-muted)" }}>벡터 생성</td>
                        <td style={{ padding: "10px 12px", textAlign: "center", fontFamily: "JetBrains Mono, monospace" }}>1,000</td>
                        <td style={{ padding: "10px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: "var(--bg-primary)", borderRadius: 3, overflow: "hidden" }}>
                              <div
                                style={{
                                  width: `${Math.min(100, ((quota.embedding?.used ?? 0) / (quota.embedding?.limit || 1)) * 100)}%`,
                                  height: "100%",
                                  background: "var(--accent-green)",
                                  borderRadius: 3,
                                }}
                              />
                            </div>
                            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--text-secondary)", minWidth: 55, textAlign: "right" }}>
                              {quota.embedding?.used ?? 0}/{quota.embedding?.limit ?? 1000}
                            </span>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: "var(--radius)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)" }}>리셋: 매일 17:00 KST</span>
                    <span style={{ color: "var(--accent-green)", fontWeight: 500 }}>
                      오늘 추가 분석 가능: ~{quota.estimatedAdditionalContracts ?? 0}건
                    </span>
                  </div>
                </>
              ) : (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>할당량 정보를 불러올 수 없습니다. Gemini API 키를 설정한 뒤 새로고침하세요.</p>
              )}
            </div>
          </div>
        </div>

        <div className="divider" />

        <div className="info-box info-green">
          ✓ Gemini API Key는 로컬 Supabase DB에 저장됩니다. 로컬 서비스(Supabase + Docling)는 Docker에서 자동 실행되므로,{" "}
          <strong>이 페이지에서 할 일은 API Key 입력뿐</strong>입니다. 한 번 저장하면 끝.
        </div>
      </div>
    </div>
  );
}
