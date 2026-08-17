# 모니터링 & 헬스체크 계획 (poa-monitoring)

피드 파이프라인과 사이트에 "죽으면 안다"를 만들고, 그 위에 메트릭 기반 관측을
학습 트랙으로 쌓는 계획. **알림 채널은 이메일로 통일한다** (healthchecks.io
이메일 + GitHub Actions 실패 메일 + 이후 Grafana 이메일 알림).

전제: 관측 대상이 성격이 다른 셋이고, 각각 요구하는 도구가 다르다.
이 구분이 계획의 뼈대다.

| 대상 | 성격 | 맞는 도구 |
|---|---|---|
| `run.sh` (하루 1회 oneshot) | 안 돌면 **조용히** 실패 — 전날 피드가 그대로 남아 겉보기 정상 | dead-man's switch + textfile 메트릭 |
| poa-embed, Caddy (상주) | 죽으면 계속 죽어 있음 | scrape (`/health`, `/metrics`) |
| `items.json` (사용자가 보는 결과물) | 내부 성공 ≠ 외부 정상 | 외부 synthetic check |

기존 soft-fail 철학은 그대로: **모니터링이 발행을 막는 일은 없다.**

이미 코드에 있는 것: `run.sh`의 `POA_HEALTHCHECK_URL` dead-man's-switch
(성공 핑 / `"$URL/fail"` 실패 핑), poa-embed의 `/health`. 단계 0~1은 이걸
마무리하는 것이고, 2~5가 새로 쌓는 것이다.

---

## 단계 0 — 이미 있는 것 마무리 (서버에서 직접, 반나절)

**만드는 것**: 새 코드 없음. 설정 + 검증.

1. **healthchecks.io 체크 생성** (무료): period `1 day`, grace `3 hours`
   (07:00 KST 런이 최대 ~12분 + 여유). 알림 채널에 이메일 확인.

   ```bash
   echo 'POA_HEALTHCHECK_URL=https://hc-ping.com/<uuid>' >> /opt/previously-on-ai/.env
   ```

2. **실패 경로 실제 테스트** — 테스트 안 한 알림은 없는 알림이다:

   ```bash
   # 일부러 실패시켜 /fail 핑 → 이메일 도착 확인
   sudo -u poa -H POA_PUBLISH_DIR=/nonexistent /opt/previously-on-ai/run.sh
   ```

3. **logrotate** — `/home/poa/poa-feed.log`가 무한 증가 중:

   ```bash
   cat > /etc/logrotate.d/poa-feed <<'EOF'
   /home/poa/poa-feed.log {
     weekly
     rotate 8
     compress
     missingok
     notifempty
     copytruncate
   }
   EOF
   ```

   `copytruncate`인 이유: cron이 `>>`로 append하는 fd를 프로세스가 다시 열
   방법이 없다 — 로그를 복사 후 원본을 truncate하는 방식이라 시그널이 필요 없다.

**완료 기준**: 성공 핑이 healthchecks.io 대시보드에 찍히고, 실패 이메일이
실제로 도착.

## 단계 1 — 외부 synthetic check (구현됨: `.github/workflows/feed-freshness.yml`)

run.sh의 성공 핑은 "서버 안에서 성공했다"이지 "방문자가 신선한 피드를 본다"가
아니다. Caddy 장애, 퍼미션, 디스크 풀은 내부 신호로 못 잡는다.

**만드는 것**: GitHub Actions cron 워크플로 (서버 밖 무료 프로버).
6시간마다 `https://sungjukim.com/data/items.json`을 fetch해서 검증:

- HTTP 200 + JSON 파싱
- `generated_at`이 **26시간 이내** (하루 런이 한 번이라도 빠지면 초과 → 알림.
  healthchecks.io와 의도적 이중화 — 서로 다른 장애를 잡는 별개의 층)
- `items.length ≥ 1`

실패하면 GitHub이 워크플로 실패 이메일을 보낸다 (별도 설정 불필요 —
Settings → Notifications → Actions에서 이메일 켜져 있는지만 확인).

**운영 캐비앳**:

- GitHub cron은 정시 부하 때문에 수분씩 지연될 수 있다 (분 값을 17로 둔 이유).
  freshness 임계에 여유가 있어 문제 없음.
- public repo는 **60일간 push가 없으면 scheduled workflow가 자동 비활성화**되고
  GitHub이 안내 메일을 보낸다 — 메일이 오면 repo에서 한 번 re-enable.

**배우는 것**: 화이트박스(내부 성공 신호) vs 블랙박스(외부 관측) 모니터링.
이중화가 아니라 서로 다른 장애를 잡는 별개의 층이다.

**완료 기준**: `workflow_dispatch`로 수동 실행해 통과 확인 + 임계를 일부러
1시간으로 줄여 실패 이메일을 받아본 뒤 26시간으로 복원.

> **여기까지가 "사이트에 문제 생기면 이메일"의 완성.** 단계 2부터는 학습
> 목적이 절반이므로 embed 서버 로드맵(v2~)과 우선순위를 조율해 진행.

## 단계 2 — 메트릭 기반: Prometheus + node_exporter + Grafana

**만드는 것**: VPS에 표준 스택 셀프호스트. Netdata·Uptime Kuma 같은 완제품이
더 쉽지만, 이 프로젝트의 목적에는 pull 모델·exporter 패턴·PromQL을 직접
밟는 쪽이 맞다.

- node_exporter (~20MB) → CPU/RAM/디스크
- Prometheus (~300MB) + Grafana (~200MB) — 8GB 예산에서 poa-embed(~0.7GB)와
  함께 여유 (리소스 예산은 `embed-serving-design.md` 참고)
- Grafana는 **localhost 바인딩 + SSH 터널**로 시작. 외부 노출은 필요해지면
  Caddy 서브도메인 + auth로.

**배우는 것**: pull 모델, exporter 패턴, 시계열 저장(TSDB retention).

**완료 기준**: 호스트 리소스 대시보드 + 디스크 사용률 추세.

## 단계 3 — 배치 런 메트릭: textfile collector

**핵심 학습 포인트.** Prometheus의 pull 모델은 하루 1회 oneshot 프로세스를
scrape할 수 없다. 해법은 둘 — Pushgateway(상주 컴포넌트 추가) vs
**node_exporter textfile collector**(파일 하나 쓰면 끝). 단일 호스트에선
textfile이 압도적으로 단순하다.

**만드는 것**: run.sh 끝(성공 핑 직전)에 `.prom` 파일 기록. 기존 soft-fail
철학대로, 기록 실패가 발행을 막지 않는다.

```
poa_last_success_timestamp_seconds
poa_run_duration_seconds
poa_tokens_used
poa_items_published
poa_crossrun_dropped
poa_age_dropped
```

`cycle-history.json`이 차트용으로 하던 일을 **알림 가능한 시계열**로도 갖게
되는 것이 차이점이다.

**완료 기준**: Grafana에 일별 비용/토큰/발행 수 패널.

## 단계 4 — poa-embed 인스트루먼테이션 (embed-serving-plan 단계 4의 "선택" 항목과 합류)

**만드는 것**: `/metrics` — 요청 수, latency histogram, 배치 크기.
`prometheus-fastapi-instrumentator`로 붙이면 5분이지만, 학습 목적이면
`prometheus_client`로 histogram을 직접 정의할 것 (버킷 설계를 고민하게 됨).
Prometheus가 scrape하면 `up` 메트릭이 공짜 헬스체크가 된다.

**완료 기준**: embed p50/p95 latency 패널 + 서비스 down 감지.

## 단계 5 — 알림 규칙 정리 (Grafana alerting, Alertmanager는 보류)

이메일 라우팅으로 시작. 규칙:

- `time() - poa_last_success_timestamp_seconds > 93600` (26h) — 이 시점에
  healthchecks.io/Actions와 삼중이 되므로, 안정되면 어디로 통합할지 판단
- 디스크 > 80%
- poa-embed `up == 0` (30분 지속)
- 사용량 급증: `poa_tokens_used`가 7일 평균의 2배 초과 (codex는 정액제라
  달러 비용이 없다 — 구독 쿼터를 태우는 토큰이 감시 대상)

**완료 기준**: 규칙별로 조건을 일부러 트리거해 테스트 이메일 수신.

---

## 전체 순서 요약

| 단계 | 산출물 | 상태 |
|---|---|---|
| 0 | healthchecks.io 설정 + 실패 테스트 + logrotate | 서버에서 수동 (명령어 위) |
| 1 | `.github/workflows/feed-freshness.yml` | **구현됨** — push 후 활성화 |
| 2 | Prometheus + node_exporter + Grafana | 학습 트랙 |
| 3 | run.sh → textfile 메트릭 | 학습 트랙 |
| 4 | poa-embed `/metrics` | embed-serving-plan 단계 4와 합류 |
| 5 | Grafana 이메일 알림 규칙 | 마지막 |

단계 0~1로 "사이트에 문제 생기면 이메일"이 완성되고, 2~5는 embed 서버
로드맵과 맞물리는 학습 트랙이다.
