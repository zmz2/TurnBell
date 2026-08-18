#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE="$GITHUB_WORKSPACE"
SOURCE_DIR="$RUNNER_TEMP/turnbell-source"
STAGING_DIR="$RUNNER_TEMP/turnbell-staging"
RELEASE_DIR="$RUNNER_TEMP/release-download"
PUBLIC_DIR="$RUNNER_TEMP/public-main"
RELEASE_TAG="v1.5.0"
EXPECTED_ARCHIVE_SHA256="10c22c9fbd6722d031cdebac6c2eb97098da9c1cf265ed0e7fffe812b311a6ee"
EXPECTED_ARCHIVE_BYTES="454292"
EXPECTED_B64_BYTES="605724"
export WORKSPACE SOURCE_DIR STAGING_DIR RELEASE_DIR PUBLIC_DIR RELEASE_TAG EXPECTED_ARCHIVE_SHA256

log() { printf '\n[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
trap 'echo "Publication failed at line $LINENO: $BASH_COMMAND" >&2' ERR

complete_source() {
  [ -f extension/manifest.json ] && [ -f README.md ] && [ -d extension/src ] && \
  node -e "const m=require('./extension/manifest.json'); if(m.manifest_version!==3||m.version!=='1.5.0') process.exit(1)" >/dev/null 2>&1
}

install_media_tools() {
  if command -v flac >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then return; fi
  sudo apt-get update
  sudo apt-get install -y flac ffmpeg
}

log "Acquire the submitted TurnBell 1.5.0 source"
rm -rf "$SOURCE_DIR" "$STAGING_DIR" "$RELEASE_DIR" "$PUBLIC_DIR"
mkdir -p "$SOURCE_DIR"
cd "$WORKSPACE"

if complete_source; then
  log "Use the complete 1.5.0 source already present on main"
  rsync -a \
    --exclude='.git' --exclude='.github' --exclude='.turnbell-*' --exclude='dist' \
    --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
    "$WORKSPACE/" "$SOURCE_DIR/"
else
  log "Restore the exact staged archive from publish-run-1.5.0"
  git ls-remote --exit-code --heads origin publish-run-1.5.0 >/dev/null || fail "main is incomplete and staging branch is missing"
  git fetch origin publish-run-1.5.0
  git worktree add --detach "$STAGING_DIR" origin/publish-run-1.5.0
  cd "$STAGING_DIR"
  mapfile -t chunks < <(find .turnbell-release-v5 -maxdepth 1 -type f -name 'chunk-*' -print | sort)
  [ "${#chunks[@]}" -eq 13 ] || fail "expected 13 source chunks, found ${#chunks[@]}"
  cat "${chunks[@]}" | tr -d '\r\n\t ' > "$RUNNER_TEMP/turnbell-source.tar.xz.b64"
  [ "$(wc -c < "$RUNNER_TEMP/turnbell-source.tar.xz.b64")" -eq "$EXPECTED_B64_BYTES" ]
  base64 --decode "$RUNNER_TEMP/turnbell-source.tar.xz.b64" > "$RUNNER_TEMP/turnbell-source.tar.xz"
  [ "$(wc -c < "$RUNNER_TEMP/turnbell-source.tar.xz")" -eq "$EXPECTED_ARCHIVE_BYTES" ]
  echo "$EXPECTED_ARCHIVE_SHA256  $RUNNER_TEMP/turnbell-source.tar.xz" | sha256sum -c --strict
  xz --test "$RUNNER_TEMP/turnbell-source.tar.xz"
  python3 - <<'PY'
import os, tarfile
from pathlib import PurePosixPath
archive=os.path.join(os.environ['RUNNER_TEMP'],'turnbell-source.tar.xz')
target=os.environ['SOURCE_DIR']
with tarfile.open(archive,'r:xz') as tf:
    members=tf.getmembers()
    for member in members:
        p=PurePosixPath(member.name)
        if p.is_absolute() or '..' in p.parts:
            raise SystemExit(f'unsafe archive path: {member.name!r}')
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f'unsupported archive member: {member.name!r}')
    tf.extractall(target,members=members,filter='data')
PY
fi

cd "$SOURCE_DIR"
if [ -d .turnbell-transport/audio ]; then
  log "Restore lossless WAV files and Chrome PNG documentation images"
  install_media_tools
  mkdir -p extension/assets/sounds
  shopt -s nullglob
  encoded_audio=(.turnbell-transport/audio/*.flac)
  [ "${#encoded_audio[@]}" -eq 5 ] || fail "expected five encoded audio files"
  for encoded in "${encoded_audio[@]}"; do
    name="$(basename "$encoded" .flac)"
    flac --decode --force --silent --force-raw-format --endian=little --sign=signed \
      "$encoded" --output-name="$RUNNER_TEMP/${name}.raw"
    cat ".turnbell-transport/audio/${name}.header" "$RUNNER_TEMP/${name}.raw" \
      > "extension/assets/sounds/${name}.wav"
  done
  ffmpeg -loglevel error -y -i docs/images/chrome-install.webp -compression_level 9 docs/images/chrome-install.png
  ffmpeg -loglevel error -y -i docs/images/chrome-notification-demo.webp -compression_level 9 docs/images/chrome-notification-demo.png
fi

log "Remove publication transport, caches, and non-source artifacts"
rm -rf .turnbell-transport .git .github dist
find . -maxdepth 1 -type d -name '.turnbell-*' -prune -exec rm -rf {} +
find . -type d -name __pycache__ -prune -exec rm -rf {} +
find . -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

log "Apply documentation-only publication normalization"
python3 - <<'PY'
from pathlib import Path
readme_path=Path('README.md')
readme='\n'.join(line for line in readme_path.read_text(encoding='utf-8').splitlines() if line.strip()!='TESTMARKER').rstrip()+'\n'
disclaimer='TurnBell 是一个非官方、独立的开源项目，与 OpenAI、Microsoft 或 Google 不存在隶属、赞助、认证、合作或背书关系。'
if disclaimer not in readme:
    readme+='\n## 非官方项目声明\n\n'+disclaimer+'\n'
readme_path.write_text(readme,encoding='utf-8')
notices_path=Path('THIRD_PARTY_NOTICES.md')
notices=notices_path.read_text(encoding='utf-8')
additions=[]
if 'Google LLC' not in notices: additions.append('- Google 和 Google Chrome 相关商标归 Google LLC 所有。')
if 'OpenAI' not in notices: additions.append('- ChatGPT 和 OpenAI 相关商标归 OpenAI 所有。')
if 'Microsoft Edge' not in notices: additions.append('- Microsoft、Windows 和 Microsoft Edge 相关商标归 Microsoft 所有。')
if additions:
    notices_path.write_text(notices.rstrip()+'\n\n## 商标说明\n\n'+'\n'.join(additions)+'\n',encoding='utf-8')
PY

log "Audit required files, platform wording, images, manifest, and privacy boundaries"
required=(
  README.md LICENSE PRIVACY.md SECURITY.md CONTRIBUTING.md THIRD_PARTY_NOTICES.md CHANGELOG.md INSTALL-WINDOWS.md
  extension/manifest.json extension/src extension/assets extension/tests scripts
  docs/images/notification-demo.webp docs/images/chrome-notification-demo.png
  docs/images/edge-install.webp docs/images/chrome-install.png
  docs/images/settings-overview.webp docs/images/settings-advanced.webp
)
for path in "${required[@]}"; do [ -e "$path" ] || fail "missing required path: $path"; done

grep -Fq 'edge://extensions/' README.md
grep -Fq 'chrome://extensions/' README.md
grep -Fq 'TurnBell-main\extension' README.md
grep -Fq 'Windows + Microsoft Edge' README.md
grep -Fq 'Windows + Google Chrome' README.md
grep -Fq 'macOS' README.md
grep -Fq 'Linux' README.md
grep -Fq 'Brave' README.md
grep -Fq 'Vivaldi' README.md
grep -Fq 'Edge InPrivate' README.md
grep -Fq 'Chrome 无痕模式' README.md
grep -Fq 'Google LLC' THIRD_PARTY_NOTICES.md
grep -Fq 'OpenAI' THIRD_PARTY_NOTICES.md
grep -Fq 'Microsoft Edge' THIRD_PARTY_NOTICES.md
! grep -R --line-number --fixed-string 'TESTMARKER' .

python3 - <<'PY'
import json,re,struct
from pathlib import Path
manifest=json.loads(Path('extension/manifest.json').read_text(encoding='utf-8'))
assert manifest['manifest_version']==3
assert manifest['version']=='1.5.0'
hosts=set(manifest.get('host_permissions',[]))
assert hosts=={'https://chatgpt.com/*','https://chat.openai.com/*'}
permissions=set(manifest.get('permissions',[]))
assert not ({'cookies','webRequest','webRequestBlocking'} & permissions)
for item in manifest.get('content_scripts',[]):
    assert set(item.get('matches',[])) <= hosts
    assert all(not re.match(r'https?://',script) for script in item.get('js',[]))
background=manifest.get('background',{})
assert not background.get('service_worker','').startswith(('http://','https://'))
source='\n'.join(p.read_text(encoding='utf-8',errors='ignore') for p in Path('extension/src').rglob('*') if p.is_file())
blocked=['chrome.webRequest','browser.webRequest','window.fetch =','globalThis.fetch =','chrome.cookies',
         '127.0.0.1','localhost:','0.0.0.0:','google-analytics.com','sentry.io','mixpanel.com','segment.io']
for token in blocked: assert token not in source,token
assert not re.search(r'<script[^>]+src=["\']https?://',source,re.I)
for name,dims in {'docs/images/chrome-install.png':(1884,1538),'docs/images/chrome-notification-demo.png':(567,288)}.items():
    data=Path(name).read_bytes()
    assert data[:8]==b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II',data[16:24])==dims
images=['docs/images/notification-demo.webp','docs/images/chrome-notification-demo.png','docs/images/edge-install.webp',
        'docs/images/chrome-install.png','docs/images/settings-overview.webp','docs/images/settings-advanced.webp']
readme=Path('README.md').read_text(encoding='utf-8')
for image in images:
    assert image in readme
    assert Path(image).stat().st_size>0
assert not any(p.suffix.lower() in {'.exe','.msi'} for p in Path('.').rglob('*') if p.is_file())
assert not any(p.name=='__pycache__' for p in Path('.').rglob('*') if p.is_dir())
PY

find extension/src -type f -print0 | sort -z | xargs -0 sha256sum > "$RUNNER_TEMP/extension-src.before.sha256"
CORE_TREE_HASH="$(sha256sum "$RUNNER_TEMP/extension-src.before.sha256" | awk '{print $1}')"
export CORE_TREE_HASH

log "Run Node tests"
node --test extension/tests/*.test.js 2>&1 | tee "$RUNNER_TEMP/node-tests.log"
grep -Eq '# tests +79$' "$RUNNER_TEMP/node-tests.log"
grep -Eq '# pass +79$' "$RUNNER_TEMP/node-tests.log"
grep -Eq '# fail +0$' "$RUNNER_TEMP/node-tests.log"

log "Run JavaScript syntax checks"
JS_FILE_COUNT="$(find extension -name '*.js' -type f | wc -l | tr -d ' ')"
export JS_FILE_COUNT
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
printf 'JavaScript syntax checked: %s files\n' "$JS_FILE_COUNT" | tee "$RUNNER_TEMP/javascript-syntax.log"

log "Run Python tests and syntax checks"
python3 -m unittest discover -s scripts/tests -v 2>&1 | tee "$RUNNER_TEMP/python-tests.log"
grep -Fq 'Ran 4 tests' "$RUNNER_TEMP/python-tests.log"
grep -Fq 'OK' "$RUNNER_TEMP/python-tests.log"
python3 -m py_compile scripts/*.py scripts/tests/*.py
printf 'Python syntax checked successfully\n' | tee "$RUNNER_TEMP/python-syntax.log"
find . -type d -name __pycache__ -prune -exec rm -rf {} +
find . -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

log "Build and verify release assets"
chmod +x scripts/build-all.sh
./scripts/build-all.sh 2>&1 | tee "$RUNNER_TEMP/build.log"
python3 scripts/verify-artifacts.py 2>&1 | tee "$RUNNER_TEMP/artifact-verification.log"
for name in TurnBell-1.5.0-extension.zip TurnBell-1.5.0-Edge-Only.zip TurnBell-1.5.0-project.zip SHA256SUMS.txt; do
  [ -f "dist/$name" ] || fail "missing release artifact: $name"
done
(cd dist && sha256sum -c SHA256SUMS.txt)

find extension/src -type f -print0 | sort -z | xargs -0 sha256sum > "$RUNNER_TEMP/extension-src.after.sha256"
diff -u "$RUNNER_TEMP/extension-src.before.sha256" "$RUNNER_TEMP/extension-src.after.sha256"

python3 - <<'PY'
import json,zipfile
from hashlib import sha256
from pathlib import Path,PurePosixPath
archives=[Path('dist/TurnBell-1.5.0-extension.zip'),Path('dist/TurnBell-1.5.0-Edge-Only.zip'),Path('dist/TurnBell-1.5.0-project.zip')]
def validate(zf):
    versions=[]
    for member in zf.namelist():
        p=PurePosixPath(member)
        assert not p.is_absolute(),member
        assert '..' not in p.parts,member
        assert not member.lower().endswith(('.exe','.msi')),member
        if member.endswith('manifest.json'):
            try: payload=json.loads(zf.read(member).decode('utf-8'))
            except Exception: continue
            if 'manifest_version' in payload: versions.append((payload.get('manifest_version'),payload.get('version')))
    assert zf.testzip() is None
    assert (3,'1.5.0') in versions
def runtime_map(zf,project=False):
    marker='/extension/src/' if project else '/src/'
    result={}
    for member in zf.namelist():
        normalized='/'+member.lstrip('/')
        if member.endswith('/') or marker not in normalized: continue
        rel=normalized.split(marker,1)[1]
        result[rel]=sha256(zf.read(member)).hexdigest()
    return result
opened=[zipfile.ZipFile(path) for path in archives]
for zf in opened: validate(zf)
a,b,c=runtime_map(opened[0]),runtime_map(opened[1]),runtime_map(opened[2],True)
assert a and a==b==c
for zf in opened: zf.close()
PY

find . -type d -name __pycache__ -prune -exec rm -rf {} +
find . -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
test -z "$(find . -type d -name __pycache__ -print -quit)"
test -z "$(find . -type f \( -name '*.pyc' -o -name '*.pyo' -o -iname '*.exe' -o -iname '*.msi' \) -print -quit)"

log "Create a normal fast-forward publication commit on main"
cd "$WORKSPACE"
git fetch origin main
git checkout -B turnbell-publication-main origin/main
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
rsync -a \
  --exclude='.git' --exclude='.github' --exclude='.turnbell-*' --exclude='dist' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
  "$SOURCE_DIR/" ./
for path in README.md LICENSE PRIVACY.md SECURITY.md CONTRIBUTING.md THIRD_PARTY_NOTICES.md CHANGELOG.md INSTALL-WINDOWS.md extension/manifest.json; do
  [ -f "$path" ] || fail "clean main missing $path"
done
[ ! -e .github ]
[ ! -e dist ]
test -z "$(find . -maxdepth 1 -type d -name '.turnbell-*' -print -quit)"
test -z "$(find . -type d -name __pycache__ -print -quit)"
test -z "$(find . -type f \( -name '*.pyc' -o -name '*.pyo' -o -iname '*.exe' -o -iname '*.msi' \) -print -quit)"
[ "$(node -p "require('./extension/manifest.json').version")" = '1.5.0' ]

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -A
git diff --cached --check
if git diff --cached --quiet; then
  FINAL_SHA="$(git rev-parse HEAD)"
else
  git commit -m 'Publish TurnBell 1.5.0'
  git push origin HEAD:main
  FINAL_SHA="$(git rev-parse HEAD)"
fi
export FINAL_SHA
printf '%s\n' "$FINAL_SHA" > "$RUNNER_TEMP/FINAL_COMMIT_SHA.txt"

log "Create or replace the v1.5.0 release"
RELEASE_EXISTED=false
TAG_EXISTED=false
if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  RELEASE_EXISTED=true
  gh release delete "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --yes --cleanup-tag
fi
if git ls-remote --tags origin "refs/tags/$RELEASE_TAG" | grep -q .; then
  TAG_EXISTED=true
  git push origin ":refs/tags/$RELEASE_TAG"
fi
export RELEASE_EXISTED TAG_EXISTED

cat > "$RUNNER_TEMP/release-notes.md" <<'EOF'
## 主要功能

- ChatGPT 回复真正完成后发送 Windows 系统通知
- 支持 Microsoft Edge 和 Google Chrome
- 支持 ChatGPT Instant / 极速回复完成提醒
- 切换标签页或其他 Windows 应用后仍可提醒
- 刷新已有对话保持静默，不误报历史回复
- 每轮至多提醒一次，并抑制重复完成信号
- 支持 Windows 默认通知声和可选本地音效
- 无需 EXE、无需本地端口或后台服务

## 隐私

- 仅在浏览器本地观察页面 DOM 状态
- 不读取 Cookie、密码、Token 或账户凭据
- 不上传对话或助手回答正文
- 不拦截 fetch、XMLHttpRequest 或网络响应流
- 不使用 webRequest
- 无遥测、广告、混淆或远程 JavaScript

## 已完成实机测试

- Windows + Microsoft Edge
- Windows + Google Chrome

## 尚未实机验证

- macOS
- Linux
- Brave、Vivaldi 等其他 Chromium 浏览器
- Edge InPrivate
- Chrome 无痕模式
- 受学校、公司或组织策略管理的浏览器环境

TurnBell 是一个非官方、独立的开源项目，与 OpenAI、Microsoft 或 Google 不存在隶属、赞助、认证、合作或背书关系。
EOF

cat "$RUNNER_TEMP/node-tests.log" "$RUNNER_TEMP/javascript-syntax.log" \
    "$RUNNER_TEMP/python-tests.log" "$RUNNER_TEMP/python-syntax.log" \
    "$RUNNER_TEMP/build.log" "$RUNNER_TEMP/artifact-verification.log" \
    > "$RUNNER_TEMP/TurnBell-1.5.0-automation.log"

cd "$SOURCE_DIR"
python3 - <<'PY'
import hashlib,json,os,platform
from pathlib import Path
names=['TurnBell-1.5.0-extension.zip','TurnBell-1.5.0-Edge-Only.zip','TurnBell-1.5.0-project.zip','SHA256SUMS.txt']
hashes={name:hashlib.sha256((Path('dist')/name).read_bytes()).hexdigest() for name in names}
data={
  'project':'TurnBell','version':'1.5.0','tag':'v1.5.0','branch':'main','commit_sha':os.environ['FINAL_SHA'],
  'source_archive_sha256':os.environ['EXPECTED_ARCHIVE_SHA256'],'extension_src_tree_hash':os.environ['CORE_TREE_HASH'],
  'automated_tests':{
    'node':{'command':'node --test extension/tests/*.test.js','passed':79,'failed':0},
    'javascript_syntax':{'command':"find extension -name '*.js' -print0 | xargs -0 -n1 node --check",'files':int(os.environ['JS_FILE_COUNT']),'status':'passed'},
    'python_unittest':{'command':'python3 -m unittest discover -s scripts/tests -v','passed':4,'failed':0},
    'python_syntax':{'command':'python3 -m py_compile scripts/*.py scripts/tests/*.py','status':'passed'},
    'build':{'command':'./scripts/build-all.sh','status':'passed'},
    'artifact_verification':{'command':'python3 scripts/verify-artifacts.py','status':'passed'}},
  'user_reported_real_device_tests':['Windows + Microsoft Edge','Windows + Google Chrome'],
  'current_runner_did_not_verify':['Windows notification visual behavior','macOS','Linux','other Chromium browsers','InPrivate/incognito','organization-managed browser environments'],
  'release_assets_sha256':hashes,'runner':platform.platform(),
  'release_preexisted':json.loads(os.environ['RELEASE_EXISTED']),'tag_preexisted':json.loads(os.environ['TAG_EXISTED'])}
Path(os.environ['RUNNER_TEMP'],'TurnBell-1.5.0-verification.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
PY

gh release create "$RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" --target "$FINAL_SHA" --title 'TurnBell 1.5.0' \
  --notes-file "$RUNNER_TEMP/release-notes.md" \
  dist/TurnBell-1.5.0-extension.zip dist/TurnBell-1.5.0-Edge-Only.zip \
  dist/TurnBell-1.5.0-project.zip dist/SHA256SUMS.txt \
  "$RUNNER_TEMP/TurnBell-1.5.0-verification.json" \
  "$RUNNER_TEMP/FINAL_COMMIT_SHA.txt" \
  "$RUNNER_TEMP/TurnBell-1.5.0-automation.log"

log "Attempt repository description and topics"
METADATA_STATUS=not-authorized
TOPICS_STATUS=not-authorized
if gh api -X PATCH "repos/$GITHUB_REPOSITORY" \
  -f description='Privacy-first completion notifications for ChatGPT on Microsoft Edge and Google Chrome.' >/dev/null 2>&1; then
  METADATA_STATUS=updated
fi
printf '%s\n' '{"names":["browser-extension","chrome-extension","edge-extension","chromium-extension","manifest-v3","chatgpt","notifications","windows","privacy","productivity"]}' > "$RUNNER_TEMP/topics.json"
if gh api -X PUT "repos/$GITHUB_REPOSITORY/topics" -H 'Accept: application/vnd.github+json' \
  --input "$RUNNER_TEMP/topics.json" >/dev/null 2>&1; then TOPICS_STATUS=updated; fi
export METADATA_STATUS TOPICS_STATUS

log "Verify the public main branch and rendered README"
for _ in $(seq 1 30); do
  remote_sha="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha 2>/dev/null || true)"
  [ "$remote_sha" = "$FINAL_SHA" ] && break
  sleep 2
done
[ "$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)" = "$FINAL_SHA" ]

git clone --depth 1 --branch main "https://github.com/${GITHUB_REPOSITORY}.git" "$PUBLIC_DIR"
cd "$PUBLIC_DIR"
[ "$(git rev-parse HEAD)" = "$FINAL_SHA" ]
for path in README.md LICENSE PRIVACY.md SECURITY.md CONTRIBUTING.md THIRD_PARTY_NOTICES.md CHANGELOG.md INSTALL-WINDOWS.md extension/manifest.json; do [ -f "$path" ]; done
[ ! -e .github ]
[ ! -e dist ]
test -z "$(find . -maxdepth 1 -type d -name '.turnbell-*' -print -quit)"
test -z "$(find . -type d -name __pycache__ -print -quit)"
test -z "$(find . -type f \( -name '*.pyc' -o -name '*.pyo' -o -iname '*.exe' -o -iname '*.msi' \) -print -quit)"
[ "$(node -p "require('./extension/manifest.json').version")" = '1.5.0' ]
node --test extension/tests/*.test.js > "$RUNNER_TEMP/public-node-tests.log" 2>&1
grep -Eq '# tests +79$' "$RUNNER_TEMP/public-node-tests.log"
grep -Eq '# pass +79$' "$RUNNER_TEMP/public-node-tests.log"
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
python3 -m unittest discover -s scripts/tests -v > "$RUNNER_TEMP/public-python-tests.log" 2>&1
grep -Fq 'Ran 4 tests' "$RUNNER_TEMP/public-python-tests.log"
grep -Fq 'OK' "$RUNNER_TEMP/public-python-tests.log"

gh api -H 'Accept: application/vnd.github.html+json' "repos/$GITHUB_REPOSITORY/readme?ref=main" > "$RUNNER_TEMP/readme.html"
images=(notification-demo.webp chrome-notification-demo.png edge-install.webp chrome-install.png settings-overview.webp settings-advanced.webp)
for name in "${images[@]}"; do
  path="docs/images/$name"
  [ -s "$path" ]
  grep -Fq "$path" README.md
  grep -Fq "$name" "$RUNNER_TEMP/readme.html"
  curl -fsSL --retry 5 "https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${FINAL_SHA}/${path}" -o "$RUNNER_TEMP/public-$name"
  cmp "$path" "$RUNNER_TEMP/public-$name"
done

curl -fsSL --retry 5 "https://github.com/${GITHUB_REPOSITORY}/archive/refs/heads/main.zip" -o "$RUNNER_TEMP/TurnBell-main.zip"
unzip -t "$RUNNER_TEMP/TurnBell-main.zip" >/dev/null
unzip -Z1 "$RUNNER_TEMP/TurnBell-main.zip" | grep -Fx 'TurnBell-main/extension/manifest.json'

log "Verify tag target and every release asset"
TAG_TYPE="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" --jq .object.type)"
TAG_SHA="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" --jq .object.sha)"
if [ "$TAG_TYPE" = tag ]; then TAG_SHA="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$TAG_SHA" --jq .object.sha)"; fi
[ "$TAG_SHA" = "$FINAL_SHA" ]
ASSETS="$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')"
for asset in TurnBell-1.5.0-extension.zip TurnBell-1.5.0-Edge-Only.zip TurnBell-1.5.0-project.zip \
  SHA256SUMS.txt TurnBell-1.5.0-verification.json FINAL_COMMIT_SHA.txt TurnBell-1.5.0-automation.log; do
  grep -Fxq "$asset" <<< "$ASSETS"
done
mkdir -p "$RELEASE_DIR"
gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --dir "$RELEASE_DIR"
cd "$RELEASE_DIR"
unzip -t TurnBell-1.5.0-extension.zip >/dev/null
unzip -t TurnBell-1.5.0-Edge-Only.zip >/dev/null
unzip -t TurnBell-1.5.0-project.zip >/dev/null
sha256sum -c SHA256SUMS.txt
[ "$(tr -d '\r\n ' < FINAL_COMMIT_SHA.txt)" = "$FINAL_SHA" ]

log "Delete every non-main branch"
cd "$WORKSPACE"
mapfile -t branches < <(gh api --paginate "repos/$GITHUB_REPOSITORY/branches?per_page=100" --jq '.[].name')
for branch in "${branches[@]}"; do
  [ "$branch" = main ] && continue
  git push origin --delete "$branch" || {
    encoded="$(jq -rn --arg value "$branch" '$value|@uri')"
    gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/heads/$encoded"
  }
done
sleep 3
mapfile -t remaining < <(gh api --paginate "repos/$GITHUB_REPOSITORY/branches?per_page=100" --jq '.[].name')
[ "${#remaining[@]}" -eq 1 ]
[ "${remaining[0]}" = main ]
[ "$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)" = "$FINAL_SHA" ]

log "Finalize the machine-readable public verification record"
python3 - <<'PY'
import json,os
from pathlib import Path
path=Path(os.environ['RUNNER_TEMP'],'TurnBell-1.5.0-verification.json')
data=json.loads(path.read_text(encoding='utf-8'))
data['public_post_publish_verification']={
  'main_commit_matches':True,
  'main_archive_contains_extension_manifest':True,
  'rendered_readme_contains_all_six_images':True,
  'release_assets_downloaded_and_crc_checked':True,
  'release_tag_targets_main_commit':True,
  'remaining_branches':['main'],
  'repository_description':os.environ['METADATA_STATUS'],
  'repository_topics':os.environ['TOPICS_STATUS']}
path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
PY
gh release upload "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" \
  "$RUNNER_TEMP/TurnBell-1.5.0-verification.json" --clobber

cat >> "$GITHUB_STEP_SUMMARY" <<EOF
# TurnBell 1.5.0 publication completed

- Final branch: main
- Final commit: \`$FINAL_SHA\`
- Release: https://github.com/$GITHUB_REPOSITORY/releases/tag/$RELEASE_TAG
- Node tests: 79 passed, 0 failed
- Python tests: 4 passed, 0 failed
- README images: six rendered references and raw bytes verified
- Remaining branches: main only
- Repository description: $METADATA_STATUS
- Repository topics: $TOPICS_STATUS
EOF

log "TurnBell 1.5.0 publication and public verification completed"
