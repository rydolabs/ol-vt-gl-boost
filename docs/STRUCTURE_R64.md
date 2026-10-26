# R64: 기능별 실행 코드 구조

이 저장소는 과거 M5 CPU-first 렌더러를 OpenLayers Vector Tile GL 렌더링을 위한 명확한 실행 경로로 재정리한 **Draft** 후보입니다. Production GO가 아닙니다.

| 폴더 | 책임 |
|---|---|
| `src/ol/` | OpenLayers Map, Layer, TileSource, frame, canvas와 자원 생명주기 |
| `src/tile/` | 지오메트리, 폴리곤/라인 패킹, 클리핑 및 피처 인코딩 |
| `src/gl/` | WebGL1 백엔드, 드로우 패킷, GPU 버퍼 및 리소스 |
| `src/optional/worker/` | CPU 결과 비교가 강제되는 선택적 Worker 인코딩. 기본 OFF |
| `src/compat/` | 예전 범용 렌더러, 호환 API 및 관련 core. 기본 경로 아님 |
| `src/index.js` | 선택적 Direct 렌더러와 하위 API 진입점 |

## 병합한 소형 기능 5개 그룹

- OL layer descriptor + layer-state watcher → `src/ol/layer-state.js`
- OL frame conversion + map frame bridge → `src/ol/frame.js`
- OL canvas host + target lifecycle → `src/ol/host.js`
- Geometry tile clipper + polygon clip precheck → `src/tile/clip.js`
- Legacy SimpleRenderer + point/polygon 1-line wrapper → `src/compat/renderers.js`

원래 62개 파일을 새로운 `src/index.js`를 포함한 57개 모듈로 정리했습니다. 거대한 `src/gl/pipeline.js`, `src/gl/ResourceManager.js`는 단순한 파일 수 감축을 위해 합치거나 연산 순서를 변경하지 않았습니다.

## 안전성 불변 조건

- 지오메트리/WebGL 결과는 R61 512×512 RGBA8 **바이트 단위 일치** 및 타일 ID 완전성으로 확인.
- R48 직접 GPU line-join 대신 CPU 정확성 경로 유지.
- 선택적 Worker **기본 OFF**, Worker ON 성능 우위를 주장하지 않음.
- 실제 Map 장애 폴백은 호스트에서 원래 OL로 되돌리는 기능이 있어야 함.
- `docs/SOURCE_PROVENANCE.json`은 원본 출처, `docs/REFACTOR_PROVENANCE.json`은 변경 후 파일 해시 확인용.
- `npm test`: 17개 Node 회귀. `npm run test:contract`: 원본·변경 후 SHA 및 기본 정책.
- `npm run test:rtx`: 실제 Windows Chrome + 물리 RTX의 12개 DPR1/2 픽셀/타일 오라클.
- `npm run test:rtx:rollback`: 앱 수준 M5 장애를 주입한 이후 OL 복구.
- 새로운 GPU나 브라우저 조합, 운영 환경 설치·킬스위치 검증은 아직 별도 승인 조건.

제3자 OL 10.10.0 코드는 현재 추적 가능한 고정 vendor 사본이며 각 패키지의 라이선스 파일을 보존했습니다. 공개 사용을 위한 원본 구현의 배포 라이선스는 소유자 검토가 필요합니다.
