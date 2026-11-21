# 사내 시스템 연동 API v1

## 역할과 운영 준비

MSDS 수집·OCR·AI 판독·추출값 확인은 사내 시스템에서 수행합니다. 이 API는 JSON 성분을 받아 기존 K-REACH·KOSHA 조회 및 함량 판정 기능을 호출합니다. AI 모델을 호출하지 않으며 MSDS 파일을 받지 않습니다. 기존 GET API와 화면은 그대로 유지합니다.

Vercel 서버 환경변수에 충분히 긴 임의의 `INTEGRATION_API_KEY`를 설정하세요. 기존 공공데이터 조회용 `API_KEY`와 다른 키입니다. 미설정 시 새 API는 503으로 닫힙니다. 키는 회사 서버의 비밀 저장소에 보관하고 Authorization 헤더로만 보내세요. 브라우저 코드·엑셀·URL에 넣지 마세요. 이 키는 새 통합 API만 보호하며 기존 공개 GET API의 접근 정책은 변경하지 않습니다.

이 API의 함수 실행 한도는 300초입니다. 배포 플랜에서 지원 여부를 확인하세요. 동기 호출이므로 회사 HTTP 클라이언트의 대기시간도 맞춰야 합니다. 운영 전 Vercel/회사 게이트웨이에서 호출량 제한과 사용량 알림을 설정하고 예상 동시 호출량으로 검증하세요. 애플리케이션 자체의 분산 호출량 제한과 비동기 작업 큐는 포함하지 않습니다.

## 호출

`POST https://chemicalevaluationocr.vercel.app/api/v1/evaluations`

헤더: `Authorization: Bearer <전용 키>`, `Content-Type: application/json`

```json
{
  "requestId": "REQ-20261121-001",
  "materialCode": "MAT-00123",
  "msdsVersionId": "MSDS-00456",
  "components": [
    {
      "componentId": "C01",
      "casNo": "96-29-7",
      "contentMin": 10,
      "contentMax": 25,
      "maxExclusive": false,
      "contentUnit": "percent"
    }
  ]
}
```

- 상위 ID 세 개 및 성분 ID는 1~128자 문자열입니다. 성분 ID는 요청 안에서 중복될 수 없습니다.
- 최대 10개 성분, 요청 JSON 최대 32 KiB. 더 많으면 나눠 호출하고 requestId와 componentId로 회사에서 합칩니다. 서버는 최대 3개 성분을 동시에 처리합니다.
- CAS 형식·체크섬을 검증합니다. 미상/영업비밀은 임의 CAS로 치환하지 말고 사내 보완 대상으로 남기세요.
- 함량은 숫자이며 25%는 `25`입니다. `contentMax`는 0 초과 100 이하, 선택 항목 `contentMin`은 0 이상 최대값 이하입니다. `maxExclusive: true`는 최대값 미만입니다.
- 하나라도 입력 오류가 있으면 전체 요청을 400으로 반환하고 조회하지 않습니다.
- 같은 요청의 중복 CAS는 KOSHA를 공유하고, CAS·최대함량·미만 여부가 같은 성분은 K-REACH도 공유합니다. 기존 원문 캐시를 재사용합니다.

## 결과 처리

응답의 `requestId`, `materialCode`, `msdsVersionId`, 성분 순서와 `componentId`는 원래 구매·MSDS 건에 연결하기 위한 값입니다. `evaluationId`는 실행마다 새로 발급됩니다. requestId는 중복 실행 방지 키가 아니며, 재시도한 결과의 채택/중복 저장은 사내 시스템에서 관리하세요.

| 필드 | 의미 |
| --- | --- |
| success / status | 모든 조회 성공이면 true / COMPLETE, 일부 조회 실패면 false / PARTIAL |
| components[].status | COMPLETE, PARTIAL(조회 실패), REVIEW_REQUIRED(조회 성공이나 물질 미확인) |
| components[].regulatoryStatus | REGULATED, NO_MATCH_IN_QUERIED_SOURCES, UNDETERMINED |
| components[].sources | 기존 kreach·kosha JSON 전체. 규제 기준·함량 판정·고유번호·원문 근거·오류 보존 |
| components[].requiredActions | 규제·오류에 따른 후속 확인 항목 배열 |
| apiVersion / logicVersion | 응답 계약 및 통합 평가 코드 버전 |
| startedAt / evaluatedAt | 이번 실행 시작·종료 UTC 시각. 원천 데이터 갱신 시각과 다름 |
| finalAdmissionDecision | 항상 REQUIRES_INTERNAL_SYSTEM_REVIEW. 입고 승인이나 연간 보고량 산정 결과가 아님 |

후속 항목: `SITE_PERMIT_REVIEW`(사업장 인허가 확인), `OCCUPATIONAL_SAFETY_REVIEW`(산안법 검토), `PROHIBITION_REVIEW`(금지 규제 확인), `VERIFY_SUBSTANCE_IDENTITY`(미확인 물질), `RETRY_OR_MANUAL_REVIEW`(조회 오류).

HTTP 200만 보고 통과시키면 안 됩니다. 각 성분의 status·regulatoryStatus·sources를 확인하세요. `notFound`는 규제 비해당이 아닙니다. 금지 규제가 한쪽에서 확인됐더라도 다른 쪽 조회 실패 정보도 함께 보존합니다. 사내 허가목록을 자동 적용하거나 최종 구매/입고를 승인하지 않습니다.

## 오류와 재시도

| HTTP | 의미 |
| --- | --- |
| 400 | JSON/입력 오류. errors 확인 후 수정 |
| 401 | 인증 실패 |
| 405 / 415 / 413 | 메서드 / 콘텐츠 형식 / 크기 오류 |
| 503 | 전용 키 또는 원천 API 키 설정 필요 |
| 200 + PARTIAL | 일부 조회 실패. sources의 errorCode·retryable 확인 |

실패 성분만 추려 재요청할 수 있습니다. retryable=true인 오류만 제한된 횟수로 간격을 늘려 재시도하세요. 플랫폼의 429/5xx/타임아웃은 JSON이 아닐 수도 있습니다. 429의 Retry-After를 준수하세요.

## 이력과 한계

응답을 입력값과 함께 회사 시스템에 보관하세요. 사이트는 이 API의 영구 평가 이력을 저장하지 않습니다. 기존 원천 API가 제공하는 데이터 버전이 있으면 sources에 보존되지만, 제공하지 않는 경우 특정 규제 스냅샷으로 재현을 보장하지 않습니다. logicVersion은 통합 코드 버전이며 규제 데이터 버전이 아닙니다. 기존 판정 코드를 바꾸면 관련 버전과 연동 검증도 갱신해야 합니다.

연간 보고에 사용할 입고량·단위 환산·함량 적용 기준·사업장 인허가 적합성은 사내 시스템이 별도로 관리합니다. 원천 API 이용 및 데이터 재제공 조건도 회사 연동 전에 확인하세요.
