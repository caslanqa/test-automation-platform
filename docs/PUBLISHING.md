# NPM'e Yayınlama Kılavuzu

Bu doküman `@caslanqa/create-playwright-ai` paketini npm'e nasıl yayınlayacağınızı ve son
kullanıcıların nasıl kuracağını anlatır. (Bu, framework'ü dağıtan **scaffolder** paketidir; son
kullanıcı `npm init` ile kullanır.)

## 🚀 GitHub Actions ile Otomatik Yayınlama (Önerilen)

### 1. NPM Token Oluşturma

1. [npmjs.com](https://www.npmjs.com) → Avatar → Access Tokens
2. "Generate New Token" → "Classic Token" → "Automation"
3. Token'ı kopyalayın

### 2. GitHub Secret Ekleme

1. GitHub repo → Settings → Secrets and variables → Actions → "New repository secret"
2. Name: `NPM_TOKEN`, Value: npm token'ınız → "Add secret"

### 3. Yayınlama (Manuel Trigger)

1. GitHub repo → Actions → **"Publish to npm"** → "Run workflow"
2. Seçenekleri belirleyin:
   - **version_type**: `patch` / `minor` / `major`
   - **dry_run**: test için `true`, gerçek yayın için `false`
   - **tag**: `latest` / `beta` / `next`
3. "Run workflow" tıklayın

```
patch: 1.2.0 → 1.2.1 (bug fix)
minor: 1.2.0 → 1.3.0 (yeni özellik)
major: 1.2.0 → 2.0.0 (breaking change)
```

`.github/workflows/publish.yml` ne yapar: lint + type-check → versiyon bump → CHANGELOG güncelle →
git commit + tag → `npm publish --access public` → GitHub Release.

---

## 📦 Manuel Yayınlama (Alternatif)

```bash
npm login                 # npmjs hesabınızla giriş
npm run lint              # kontroller
npm run type-check
npm pack --dry-run        # tarball içeriğini gözden geçirin
npm version patch         # veya minor / major
npm publish --access public   # scoped paket → --access public şart
```

> **Not:** Yayınlamadan önce `npm pack --dry-run` çıktısında `env/environments.json` veya
> `testData/users.json` gibi **local** dosyaların OLMADIĞINI doğrulayın — yalnızca `*.example.json`
> gönderilir (`package.json` `files` bunu sağlar).

---

## 🖥️ Son Kullanıcı Kurulumu

Yayınlandıktan sonra herhangi bir makinede tek komutla kullanıma hazır proje:

```bash
# npm, scoped "create" paketini otomatik @caslanqa/create-playwright-ai'a çözer
npm init @caslanqa/playwright-ai@latest my-project

cd my-project
npm test                       # çalışır durumda
npx playwright install         # UI testleri için tarayıcılar (API/AI-judge için gerekmez)
```

Eşdeğer formlar:

```bash
npm  create @caslanqa/playwright-ai@latest my-project
npx  @caslanqa/create-playwright-ai my-project
yarn create @caslanqa/playwright-ai my-project
pnpm create @caslanqa/playwright-ai my-project
```

Flag'ler: `--no-install`, `--no-browsers`, `--no-gha`, `-y/--yes`.

---

## 🔢 Versiyon Yönetimi

```bash
npm view @caslanqa/create-playwright-ai version     # yayındaki sürüm
npm view @caslanqa/create-playwright-ai versions    # tüm sürümler

# Beta
npm version prerelease --preid=beta
npm publish --tag beta --access public
npx @caslanqa/create-playwright-ai@beta my-project
```

---

## ❓ Sorun Giderme

- **"You must be logged in"** → `npm login` (kontrol: `npm whoami`).
- **"Permission denied" / scoped paket** → `npm publish --access public`.
- **Yanlış dosyalar yayınlanıyor** → `package.json` `files` alanını ve `npm pack --dry-run` çıktısını
  kontrol edin.
