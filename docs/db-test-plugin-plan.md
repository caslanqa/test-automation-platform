M6 — @pwtap/plugin-db

     ▎ Not: Bu dosyanın altındaki eski M5 (@pwtap/plugin-appium) planı TAMAMLANDI, canlı doğrulandı ve
     ▎ feat/appium-plugin-integration branch'inde (henüz commit edilmemiş, commit mesajı kullanıcıya
     ▎ verildi). Aşağısı yeni istenen milestone'un planı: veritabanı testleri için geniş kapsamlı bir
     ▎ plugin — PostgreSQL, MySQL, MariaDB, SQLite (Knex üzerinden) ve MongoDB (resmi sürücü üzerinden);
     ▎ query+assertion, seed/reset, ve migration testi kapsıyor (kullanıcının seçimi: "hepsi").

     Context (neden)

     Mevcut platformda test türleri (UI, API, Maestro/Appium mobil) hep dış bir sistemle konuşan
     fixture'lar olarak modellenmiş — ama hiçbiri veritabanına doğrudan bağlanıp sorgu/assert yapmıyor.
     Gerçek dünyada en yaygın DB test ihtiyacı: bir API/UI aksiyonundan sonra "veritabanında doğru kayıt
     oluştu mu" diye doğrulamak. Kullanıcı bunu genişleterek üç yeteneği birden istedi: (1) doğrudan
     query+assertion, (2) test izolasyonu için seed/reset, (3) migration (up/down) doğrulaması — ve tüm
     büyük motorları: PostgreSQL, MySQL, MariaDB, MongoDB.

     Kesinleşen tasarım kararları

     1. İki bağımsız fixture ailesi, tek "evrensel" API değil. SQL ailesi (Postgres/MySQL/MariaDB/
     SQLite) ile MongoDB kökten farklı veri modelleri (ilişkisel vs döküman) — yapay bir ortak katman
     leaky abstraction olurdu (Appium'da "raw driver, curated facade yok" kararının aynısı, burada da
     geçerli). Bunun yerine:
       - SQL: option db (test.use({ db: { client: 'pg'|'mysql'|'mariadb'|'sqlite3', connection } }))
     → fixture sql = ham Knex instance'ı, hiç sarmalama yok. Knex zaten
     çağrılabilir bir query builder (sql('users').where({id}).first()), MariaDB mysql/mysql2
     client'ıyla wire-uyumlu bağlanır.
       - MongoDB: option mongoDb (test.use({ mongoDb: { connection, database } })) → fixture
     mongo = ham Db instance'ı (resmi mongodb sürücüsünün client.db(name)'i), yine sarmalama
     yok (mongo.collection('users').find({...}).toArray()).
       - Appium'daki "option adı ile fixture adı çakışmasın" dersi burada baştan uygulanıyor: db≠sql,
     mongoDb≠mongo — dört isim de birbirinden ve diğer plugin'lerden (mobile/maestro/appium/device)
     ayrık, aynı barrel'da hepsi birlikte sorunsuz mergeTests edilebilir.
     2. Bağlantı yaşam döngüsü: worker-scoped fixture (Playwright'ın kendi { scope: 'worker' } özelliği),
     cihaz-tarzı per-test lock DEĞİL. Mobil cihazlar münhasır kaynak (aynı anda tek test), DB
     bağlantıları ise havuzlanabilir (Knex/MongoDB sürücüsü zaten kendi connection pool'unu yönetir) —
     bu yüzden worker başına BİR Knex/MongoClient instance'ı kurulur, o worker'ın tüm testleri paylaşır,
     worker bittiğinde Playwright'ın kendisi otomatik teardown eder. Maestro/Appium'daki gibi ayrı bir
     *-teardown project'i GEREKMİYOR — bu native Playwright mekanizması zaten yeterli ve daha basit.
     3. Bağlanamıyorsa SKIP, asla fail değil (aynı "cihaz yoksa skip" felsefesi). İlk bağlantıda bir
     ping (SELECT 1 / MongoDB db.command({ ping: 1 })) atılır; başarısızsa testInfo.skip(...).
     4. Migration: SQL tarafı Knex'in KENDİ migration sistemini birebir kullanır (yeni kod yok, sadece
     wiring) — knexfile.ts + db/migrations/*.ts (exports.up/exports.down), npm script'leri
     (db:migrate:latest, db:migrate:rollback, db:migrate:make) Knex CLI'a delege eder. MongoDB
     tarafı için küçük, öz bir migration runner yazılır (üçüncü bir bağımlılık — migrate-mongo vb. —
     eklemeden): db/migrations-mongo/*.ts dosyaları aynı up(db)/down(db) imzasıyla, uygulanmış
     migration'lar bir _migrations koleksiyonunda (name, appliedAt) izlenir — iki motor arasında
     aynı yazım deneyimi (dosya kongvansiyonu), farklı motor (Knex'in kendi sistemi vs bizim küçük
     runner'ımız).
     5. Reset yardımcıları, ince ve motor-bazlı: resetDatabase(sql, { tables? }) — Postgres/MySQL/
     MariaDB için TRUNCATE ... RESTART IDENTITY CASCADE / SET FOREIGN_KEY_CHECKS=0; TRUNCATE; SET...=1,
     SQLite için DELETE FROM (TRUNCATE desteklemiyor). resetDatabase(mongo, { collections? }) — her
     koleksiyonda deleteMany({}), ya da parametresiz çağrıda tüm koleksiyonları temizler.
     6. Manifest şekli maestro/appium'dan FARKLI, ai-judge'a daha yakın: env-gated bir Playwright
     project YOK. DB fixture'ları asıl kullanım şekliyle (bir API/UI testinin İÇİNDE "DB'de doğru
     kayıt var mı" diye bakmak) mevcut api/chromium projelerine bağımlı — ayrı bir db project'i
     bunu zorlaştırırdı. sql/mongo fixture'ları barrel'a mergeTests ile eklenir, HER test dosyasında
     kullanılabilir (ai-judge'ın expectAi gibi). Bağımsız "sadece DB" test dosyaları da (ör. migration
     doğrulaması) aynı barrel'ı kullanarak tests/db/*.ts altında yazılabilir — ayrı project/gate şart
     değil, sadece connection yoksa/erişilemezse testInfo.skip() zaten koruyor.
     7. Bağımlılıklar: knex + mongodb düz dependencies (appium'un webdriverio'yu düz dependency
     yapması gibi). Gerçek SQL sürücüleri (pg, mysql2, better-sqlite3) peer dependency + optional: true — kullanıcı sadece kullandığı
     motorun paketini kurar.

     Uygulama adımları

     Adım 1 — packages/plugin-db paketini iskele et. package.json: exports haritası ., ./manifest,
     ./ensure (M4/M5'te öğrenilen zorunlu desen). dependencies: { knex, mongodb },
     peerDependencies: { pg, mysql2, better-sqlite3 (hepsi ^opsiyonel aralık), "@playwright/test": ">=1.61.0" },
     peerDependenciesMeta: { pg: {optional:true}, mysql2: {optional:true}, "better-sqlite3": {optional:true} }.
     tsconfig.json maestro/appium'unkini birebir yansıtır (references: [{path:"../platform"}] GEREKMEZ —
     bu plugin @pwtap/platform'a bağımlı değil, cihaz/OS seam'i kullanmıyor). Root tsconfig.json'a referans.

     Adım 2 — src/core/sqlConnection.ts — createSqlConnection(options): Knex instance'ı kurar, ilk
     kullanımda SELECT 1 ping'i atar (bağlanamazsa null döner, fixture bunu skip'e çevirir),
     closeSqlConnection(knex) (knex.destroy()).

     Adım 3 — src/core/mongoConnection.ts — createMongoConnection(options): MongoClient açar +
     db.command({ping:1}), client.db(database) döner (null bağlanamazsa), closeMongoConnection(client)
     (client.close()).

     Adım 4 — src/core/resetSql.ts + src/core/resetMongo.ts — Adım 5'teki reset yardımcıları,
     motor bazlı (Knex client.config.client alanından hangi dialekt olduğunu okur).

     Adım 5 — src/core/mongoMigrate.ts — küçük runner: runMongoMigrations(mongo, dir) (pending
     dosyaları _migrations koleksiyonuna göre bulur, sırayla up(db) çağırır, kaydeder) +
     rollbackMongoMigration(mongo, dir) (son uygulanan migration'ın down(db)'ini çağırır, kaydı siler).

     Adım 6 — src/fixtureSql.ts — db option + sql fixture ({scope:'worker'}): worker başına bir
     Knex instance'ı, ilk testte ping/skip, worker sonunda knex.destroy() (Playwright'ın worker-fixture
     teardown'ı otomatik tetikler — ekstra kod gerekmez).

     Adım 7 — src/fixtureMongo.ts — aynı desen, mongoDb option + mongo fixture ({scope:'worker'}).

     Adım 8 — src/index.ts — iki test/expect çifti nasıl tek barrel'da birleşecek: aslında TEK
     test objesi olmalı (base.extend ile iki fixture ailesi birlikte tanımlanır, ayrı ayrı dosyalarda
     tanımlanan option+fixture'lar mergeTests ile DEĞİL, doğrudan aynı base.extend({...sqlFixtures, ...mongoFixtures}) çağrısında
     birleştirilir — maestro/appium'un ayrı paketler olmasından farklı olarak
     bu İKİSİ AYNI paketin içinde, o yüzden tek extend). Export: test, expect, resetDatabase (sql
     overload + mongo overload), runMongoMigrations/rollbackMongoMigration.

     Adım 9 — src/ensure.ts — advisory: knex/mongodb her zaman bundle (kontrol gerekmez); DB_CLIENT
     env'ine göre seçili sürücü paketinin (pg/mysql2/better-sqlite3) kurulu olup olmadığını
     require.resolve ile kontrol et; MONGO_CONNECTION_STRING set edilmişse mongodb'nin kurulu olduğunu
     doğrula (zaten dependency, hep true — asıl kontrol gerçek bağlantı, o yüzden burada sadece env
     eksikse ipucu ver).

     Adım 10 — src/manifest.ts — id:'db', playwrightProject YOK (Karar 6), envKeys
     (DB_CLIENT, DB_CONNECTION_STRING, MONGO_CONNECTION_STRING, MONGO_DATABASE), fixture.test.alias: 'dbTest', scripts (db:migrate:latest,
     db:migrate:rollback, db:migrate:make, db:seed,
     db:mongo:migrate, db:mongo:migrate:rollback — hepsi ince CLI/programatik wrapper'lar),
     examples (templates/tests → tests/db, templates/db → db [knexfile.ts + migrations/ +
     migrations-mongo/ + seeds/]), docs, ensure:'ensure'.

     Adım 11 — templates/ — db/knexfile.ts (env'den DB_CLIENT/DB_CONNECTION_STRING okur),
     db/migrations/0001_example.ts (basit bir users tablosu create/drop), db/migrations-mongo/ 0001_example.ts (aynı örnek, koleksiyon
     üzerinde), db/seeds/example.ts, tests/db/example.db.ts
     (sql+mongo fixture kullanımı + resetDatabase örneği, bağlantı yoksa skip).

     Adım 12 — docs — README.md + docs/DB_TESTING.md: iki motor ailesinin fixture kullanımı,
     migration/seed/reset akışı, "neden ayrı iki fixture" gerekçesi, gereksinimler (bir çalışan DB instance'ı
     — bu plugin kendi DB'sini KURMAZ, maestro/appium'un cihaz kurmaması gibi; docker-compose ile lokal
     Postgres/Mongo ayağa kaldırma örneği verilir, opsiyonel bir kolaylık notu olarak).

     Adım 13 — packages/create/src/registry.ts — yeni girdi: {id:'db', package:'@pwtap/plugin-db', category:'data', description:'Database
     testing (Postgres/MySQL/MariaDB/SQLite via Knex, MongoDB) — query assertions, seed/reset, migrations', flag:'--db',
     defaultSelected:false, status:'stable'}.

     Adım 14 — .commitlintrc.json — scope-enum'a "db" ekle (appium eklenirken yapılan hatayı
     tekrarlamamak için, aynı commit'te).

     Adım 15 — changesets — @pwtap/plugin-db yeni paket olduğu için (maestro/appium presedanına göre)
     kendi changeset'i GEREKMEZ — @pwtap/create'e bir patch changeset (registry kaydı) yeter.

     Doğrulama

     - npx tsc -b + eslint temiz.
     - M4/M5'teki gibi: taze create scaffold → tarball pack+kur → add db --no-install → barrel'da
     sql+mongo fixture'larının merge edildiğini, DB_*/MONGO_* env enjeksiyonunu, örnek dosyaların
     kopyalandığını doğrula → tsc --noEmit yeşil.
     - Canlı doğrulama (önerilen, onay bekliyor): Bu makinede Docker varsa docker run ile geçici bir
     Postgres + bir MongoDB konteyneri ayağa kaldırıp gerçek bir bağlantı+query+migration+reset döngüsünü
     uçtan uca test et (M5'teki gibi — gerçek env'e karşı canlı doğrulama, sadece izole birim testi değil).
     Docker yoksa (veya kullanıcı istemezse) sadece yapısal doğrulamayla (tsc/lint/scaffold) yetinilir.
     - MariaDB/MySQL/SQLite için ayrı canlı kurulum muhtemelen zaman/karmaşıklık nedeniyle kapsam dışı
     bırakılır — Postgres, Knex'in tüm SQL dialektleri için AYNI kod yolunu kullandığını kanıtlamaya
     yeter (query builder + migration API dialekt-agnostik); MongoDB tamamen farklı kod yolu olduğu için
     ayrıca doğrulanır.
