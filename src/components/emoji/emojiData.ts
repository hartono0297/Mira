// Data emoji pemilih emoji Mira, dibuat sendiri tanpa pustaka supaya ringan dan
// punya nama serta kata kunci bahasa Indonesia. Isinya emoji yang umum dipakai di
// kantor, hanya Unicode 13 atau lebih lama supaya tampil di Segoe UI Emoji
// (Windows 10 dan 11).
//
// Format tiap baris: emoji|nama Indonesia|nama Inggris|kata kunci dipisah spasi.
// Emoji satu titik kode yang bawaannya tampil sebagai teks (misalnya ☀ atau ❤)
// diberi U+FE0F otomatis saat dibaca, jadi tulisan di bawah aman walau
// selektor variasinya hilang saat disunting.

export type EmojiCategory = "faces" | "people" | "symbols" | "nature" | "food" | "activity" | "travel" | "flags";

export type EmojiEntry = { char: string; id: string; en: string; keywords: string[]; category: EmojiCategory };

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  "faces",
  "people",
  "symbols",
  "nature",
  "food",
  "activity",
  "travel",
  "flags",
];

// Ikon tab kategori: satu emoji yang mewakili isi kategorinya.
export const CATEGORY_ICON: Record<EmojiCategory, string> = {
  faces: "😀",
  people: "👋",
  symbols: "❤️",
  nature: "🌿",
  food: "☕",
  activity: "💼",
  travel: "🚗",
  flags: "🏁",
};

// Reaksi cepat di samping pesan, urut seperti tampil.
export const QUICK_REACTIONS: readonly string[] = ["👍", "❤️", "😂", "🙏", "😮"];

const RAW: Record<EmojiCategory, string> = {
  faces: `
😀|senyum lebar|grinning face|senang gembira happy smile
😃|senyum mata lebar|grinning face with big eyes|senang happy smile
😄|senyum ceria|grinning face with smiling eyes|senang ceria happy
😁|nyengir|beaming face|senyum gigi grin
😆|tertawa lepas|grinning squinting face|ketawa ngakak laugh lol
😅|senyum berkeringat|grinning face with sweat|lega gugup relief nervous
🤣|tertawa berguling|rolling on the floor laughing|ngakak ketawa lol rofl
😂|tertawa sampai menangis|face with tears of joy|ngakak ketawa lucu lol laugh funny
🙂|senyum tipis|slightly smiling face|senyum smile
🙃|wajah terbalik|upside down face|bercanda sarkas silly
😉|mengedip|winking face|kedip canda wink
😊|senyum malu|smiling face with smiling eyes|senang malu blush happy
😇|malaikat|smiling face with halo|baik suci angel innocent
🥰|penuh cinta|smiling face with hearts|sayang cinta love adore
😍|mata hati|smiling face with heart eyes|suka cinta love
🤩|terpukau|star struck|kagum takjub wow amazed
😘|kirim cium|face blowing a kiss|cium sayang kiss
😋|lezat|face savoring food|enak makan yummy delicious
😛|julur lidah|face with tongue|lidah canda tongue
😜|julur lidah mengedip|winking face with tongue|canda iseng silly
🤪|wajah konyol|zany face|gila konyol crazy goofy
🤑|mata uang|money mouth face|uang duit money rich
🤗|memeluk|hugging face|peluk hug
🤭|tutup mulut|face with hand over mouth|ups malu oops giggle
🤫|sst|shushing face|diam rahasia quiet secret
🤔|berpikir|thinking face|mikir hmm think
🤐|mulut terkunci|zipper mouth face|rahasia diam secret
🤨|alis terangkat|face with raised eyebrow|curiga ragu skeptical
😐|datar|neutral face|biasa meh neutral
😶|tanpa mulut|face without mouth|diam speechless
😏|menyeringai|smirking face|licik smug smirk
😒|tidak senang|unamused face|kesal bete unamused
🙄|memutar mata|face with rolling eyes|bosan kesal eyeroll
😬|meringis|grimacing face|canggung awkward grimace
😌|lega|relieved face|tenang calm relief
😔|termenung|pensive face|murung sedih sad pensive
😪|mengantuk|sleepy face|ngantuk sleepy
🤤|ngiler|drooling face|lapar ngences drool
😴|tidur|sleeping face|zzz sleep
😷|bermasker|face with medical mask|sakit masker sick mask
🤒|demam|face with thermometer|sakit panas sick fever
🤕|kepala diperban|face with head bandage|luka sakit hurt
🤢|mual|nauseated face|muak sick
🤮|muntah|face vomiting|jijik vomit
🤧|bersin|sneezing face|pilek flu sneeze
🥵|kepanasan|hot face|panas gerah hot
🥶|kedinginan|cold face|dingin beku cold freezing
🥴|pusing|woozy face|mabuk linglung dizzy
😵|pening|dizzy face|pusing bingung dizzy
🤯|kepala meledak|exploding head|kaget takjub mind blown
🥳|berpesta|partying face|pesta ulang tahun party celebrate
😎|keren|smiling face with sunglasses|kacamata santai cool
🤓|kutu buku|nerd face|pintar geek nerd
🧐|meneliti|face with monocle|cermat periksa inspect
😕|bingung|confused face|heran confused
😟|khawatir|worried face|cemas worried
🙁|cemberut|slightly frowning face|sedih frown
😮|terkejut|face with open mouth|kaget wow surprised
😯|tercengang|hushed face|heran hushed
😲|kaget sekali|astonished face|terkejut shocked
😳|tersipu|flushed face|malu embarrassed
🥺|memohon|pleading face|mohon please puppy
😨|takut|fearful face|ngeri scared
😰|cemas berkeringat|anxious face with sweat|gugup anxious
😢|menangis|crying face|sedih nangis cry sad
😭|menangis keras|loudly crying face|nangis sedih sob
😱|menjerit takut|face screaming in fear|horor kaget scream
😞|kecewa|disappointed face|sedih disappointed
😩|lelah|weary face|capek letih tired weary
🥱|menguap|yawning face|ngantuk bosan yawn
😤|mendengus|face with steam from nose|kesal menang huff
😡|marah besar|pouting face|marah kesal angry rage
😠|marah|angry face|kesal angry mad
🤬|memaki|face with symbols on mouth|marah sumpah cursing
😈|setan tersenyum|smiling face with horns|nakal devil
💀|tengkorak|skull|mati ngakak dead
💩|kotoran|pile of poo|tai poop
👻|hantu|ghost|seram boo
🤖|robot|robot|mesin bot
😺|kucing senyum|grinning cat|kucing cat
`,
  people: `
👋|melambai|waving hand|halo dadah hai hello bye wave
✋|angkat tangan|raised hand|stop tos tangan high five
🖐|tangan terbuka|hand with fingers splayed|lima tangan five
👌|oke|ok hand|baik sip ok
✌|damai|victory hand|peace dua jari
🤞|semoga|crossed fingers|harap beruntung luck hope
🤟|aku sayang kamu|love you gesture|cinta love
🤙|hubungi aku|call me hand|telepon shaka call
👈|tunjuk kiri|backhand index pointing left|kiri left
👉|tunjuk kanan|backhand index pointing right|kanan right
👆|tunjuk atas|backhand index pointing up|atas up
👇|tunjuk bawah|backhand index pointing down|bawah down
☝|telunjuk ke atas|index pointing up|satu penting one
👍|jempol|thumbs up|setuju oke bagus suka sip like yes approve
👎|jempol bawah|thumbs down|tidak setuju jelek dislike no
✊|kepalan tangan|raised fist|semangat lawan fist
👊|tinju|oncoming fist|tos pukul punch bump
👏|tepuk tangan|clapping hands|bravo hebat selamat clap applause
🙌|angkat dua tangan|raising hands|hore horee hooray celebrate
👐|tangan terbuka lebar|open hands|peluk hands
🤲|telapak menengadah|palms up together|doa berdoa pray
🤝|jabat tangan|handshake|salaman sepakat deal agree
🙏|terima kasih|folded hands|tolong doa mohon makasih thanks please pray
✍|menulis|writing hand|tulis catat write
💪|otot|flexed biceps|kuat semangat strong muscle
🧠|otak|brain|pintar pikir smart
👀|mata|eyes|lihat cek perhatikan look see watch
👂|telinga|ear|dengar listen
🙋|angkat tangan bertanya|person raising hand|tanya hadir saya question
🙆|isyarat oke|person gesturing ok|setuju ok
🙅|isyarat tidak|person gesturing no|tolak no
💁|memberi info|person tipping hand|info
🤷|angkat bahu|person shrugging|entah tidak tahu shrug dunno
🤦|tepuk jidat|person facepalming|aduh facepalm
🙇|membungkuk|person bowing|maaf hormat sorry bow
🧑‍💻|pekerja teknologi|technologist|programmer kerja laptop coder developer
🧑‍💼|pekerja kantor|office worker|karyawan kantor office employee
👷|pekerja konstruksi|construction worker|proyek lapangan helm builder
🧑‍🔧|mekanik|mechanic|teknisi perbaikan technician
🧑‍🏫|guru|teacher|pengajar mentor
🧑‍🍳|koki|cook|masak chef
🧑‍⚕️|tenaga kesehatan|health worker|dokter perawat doctor nurse
👥|dua siluet|busts in silhouette|tim grup orang team group
🗣|berbicara|speaking head|bicara presentasi speak
🏃|berlari|person running|lari cepat buru run hurry
🚶|berjalan|person walking|jalan walk
🧘|bermeditasi|person in lotus position|tenang yoga meditate
`,
  symbols: `
❤|hati merah|red heart|cinta sayang love heart
🧡|hati oranye|orange heart|cinta love heart
💛|hati kuning|yellow heart|cinta love heart
💚|hati hijau|green heart|cinta love heart
💙|hati biru|blue heart|cinta love heart
💜|hati ungu|purple heart|cinta love heart
🤎|hati cokelat|brown heart|cinta love heart
🖤|hati hitam|black heart|cinta love heart
🤍|hati putih|white heart|cinta love heart
💔|patah hati|broken heart|sedih heartbreak
❣|hati tanda seru|heart exclamation|cinta love
💕|dua hati|two hearts|cinta sayang love
💖|hati berkilau|sparkling heart|cinta love
💘|hati panah|heart with arrow|cinta cupid love
💯|seratus|hundred points|sempurna mantap perfect
✅|centang hijau|check mark button|selesai beres done ok yes
✔|centang|check mark|benar beres done ok
☑|kotak centang|check box with check|tugas todo done
❌|silang|cross mark|salah tidak batal no wrong cancel
➕|tambah|plus|plus add
➖|kurang|minus|minus
❓|tanda tanya|question mark|tanya question
❗|tanda seru|exclamation mark|penting important
⚠|peringatan|warning|awas hati caution
🚫|dilarang|prohibited|larang no forbidden
⛔|tidak boleh masuk|no entry|stop larang
🔴|lingkaran merah|red circle|merah sibuk busy red
🟠|lingkaran oranye|orange circle|oranye orange
🟡|lingkaran kuning|yellow circle|kuning yellow
🟢|lingkaran hijau|green circle|hijau siap online green
🔵|lingkaran biru|blue circle|biru blue
⚫|lingkaran hitam|black circle|hitam black
⚪|lingkaran putih|white circle|putih white
⭐|bintang|star|favorit star
🌟|bintang bersinar|glowing star|hebat bintang star
✨|kilau|sparkles|baru bersih sparkle new
🔥|api|fire|panas keren mantap hot lit
💤|zzz|zzz|tidur sleep
💬|balon kata|speech balloon|chat obrolan komentar comment message
💭|balon pikiran|thought balloon|pikir think
🔔|lonceng|bell|notifikasi pengingat notification
🔕|lonceng mati|bell with slash|bisu mute
📣|pengeras suara|megaphone|pengumuman announcement
📢|pengumuman|loudspeaker|umumkan announcement
🆗|tombol ok|ok button|oke ok
🆘|minta tolong|sos button|darurat tolong help
♻|daur ulang|recycling symbol|recycle
➡|panah kanan|right arrow|lanjut kanan next
⬅|panah kiri|left arrow|kembali kiri back
⬆|panah atas|up arrow|naik up
⬇|panah bawah|down arrow|turun down
🔄|putar ulang|counterclockwise arrows button|ulang sinkron refresh sync
#️⃣|tanda pagar|keycap number sign|hashtag pagar
1️⃣|angka satu|keycap 1|satu one
🔒|gembok|locked|kunci aman lock secure
🔓|gembok terbuka|unlocked|buka unlock
🔑|kunci|key|sandi akses password
⏳|jam pasir|hourglass not done|tunggu proses wait
⌛|jam pasir habis|hourglass done|waktu habis time
⏰|jam weker|alarm clock|alarm bangun tenggat deadline
`,
  nature: `
🐶|anjing|dog face|guk puppy dog
🐱|kucing|cat face|meong cat
🐰|kelinci|rabbit face|rabbit bunny
🦊|rubah|fox|fox
🐻|beruang|bear|bear
🐼|panda|panda|panda
🐯|harimau|tiger face|macan tiger
🦁|singa|lion|lion
🐸|katak|frog|kodok frog
🐵|monyet|monkey face|monkey
🙈|monyet tutup mata|see no evil monkey|malu tidak lihat shy
🙊|monyet tutup mulut|speak no evil monkey|ups rahasia oops
🐔|ayam|chicken|ayam chicken
🐧|penguin|penguin|penguin
🐦|burung|bird|bird
🦅|elang|eagle|garuda eagle
🦆|bebek|duck|itik duck
🐝|lebah|honeybee|rajin bee
🦋|kupu kupu|butterfly|butterfly
🐌|siput|snail|lambat slow
🐢|kura kura|turtle|lambat slow
🐍|ular|snake|snake
🐟|ikan|fish|fish
🐬|lumba lumba|dolphin|dolphin
🐳|paus|spouting whale|whale
🐘|gajah|elephant|elephant
🐎|kuda|horse|horse
🌸|bunga sakura|cherry blossom|bunga flower
🌹|mawar|rose|bunga flower
🌻|bunga matahari|sunflower|bunga flower
🌷|tulip|tulip|bunga flower
💐|buket bunga|bouquet|selamat bunga flowers
🌱|tunas|seedling|tumbuh mulai grow
🌿|daun|herb|daun tanaman leaf plant
🍀|semanggi|four leaf clover|beruntung lucky
🍂|daun gugur|fallen leaf|daun leaf
🌴|pohon kelapa|palm tree|pantai pohon tree
🌳|pohon|deciduous tree|tree
🌵|kaktus|cactus|cactus
☀|matahari|sun|cerah panas sunny
⛅|berawan|sun behind cloud|mendung cloudy
☁|awan|cloud|mendung cloudy
🌧|hujan|cloud with rain|hujan rain
⛈|badai|cloud with lightning and rain|petir storm
⚡|petir|high voltage|listrik cepat lightning
🌈|pelangi|rainbow|rainbow
❄|salju|snowflake|dingin snow
🌊|ombak|water wave|laut banjir sea wave
🌙|bulan sabit|crescent moon|malam night moon
🌏|bumi asia|globe showing asia australia|dunia indonesia world earth
`,
  food: `
☕|kopi|coffee|minum panas teh hot beverage drink
🍵|teh|teacup without handle|minum tea drink
🥤|minuman gelas|cup with straw|es soda drink
🧋|teh boba|bubble tea|boba teh susu
🥛|susu|glass of milk|milk
🧊|es batu|ice|dingin ice
🍚|nasi|cooked rice|makan rice
🍛|nasi kari|curry rice|kari curry
🍜|mi kuah|steaming bowl|mie bakso noodles ramen
🍲|sup|pot of food|soto sop stew soup
🍱|bento|bento box|bekal nasi kotak lunch box
🍙|nasi kepal|rice ball|onigiri
🍢|sate|oden|tusuk satay skewer
🍤|udang goreng|fried shrimp|tempura shrimp
🍗|paha ayam|poultry leg|ayam goreng chicken
🥩|potongan daging|cut of meat|steak
🍔|burger|hamburger|burger
🍟|kentang goreng|french fries|fries
🍕|pizza|pizza|pizza
🥪|roti lapis|sandwich|sandwich
🍳|telur ceplok|cooking|telur goreng masak egg fry
🥚|telur|egg|egg
🍞|roti|bread|sarapan bread
🥐|croissant|croissant|roti pastry
🥗|salad|green salad|sayur gado salad
🥟|pangsit|dumpling|dimsum dumpling
🍰|kue potong|shortcake|kue cake
🎂|kue ulang tahun|birthday cake|ultah selamat birthday cake
🍩|donat|doughnut|donut
🍪|kue kering|cookie|biskuit cookie
🍫|cokelat|chocolate bar|chocolate
🍬|permen|candy|manis candy
🍦|es krim|soft ice cream|ice cream
🍉|semangka|watermelon|buah fruit
🍌|pisang|banana|buah fruit
🍎|apel|red apple|buah apple fruit
🍊|jeruk|tangerine|buah orange fruit
🍓|stroberi|strawberry|buah fruit
🍍|nanas|pineapple|buah fruit
🥭|mangga|mango|buah fruit
🥥|kelapa|coconut|degan fruit
🥑|alpukat|avocado|buah fruit
🌶|cabai|hot pepper|pedas sambal spicy chili
🌽|jagung|ear of corn|corn
🍿|berondong|popcorn|nonton popcorn
🍴|garpu dan pisau|fork and knife|makan siang lunch eat
🥢|sumpit|chopsticks|makan chopsticks
`,
  activity: `
🎉|konfeti|party popper|selamat hore pesta congrats celebrate tada
🎊|bola konfeti|confetti ball|selamat pesta celebrate
🎈|balon|balloon|ulang tahun party
🎁|hadiah|wrapped gift|kado gift present
🏆|piala|trophy|juara menang winner
🥇|medali emas|1st place medal|juara satu gold
🎯|tepat sasaran|direct hit|target fokus goal bullseye
⚽|sepak bola|soccer ball|bola football
🏀|bola basket|basketball|basket
🏸|bulu tangkis|badminton|badminton
🎮|gim|video game|main game
🧩|keping puzzle|puzzle piece|teka teki puzzle
🎵|nada|musical note|musik music
🎤|mikrofon|microphone|karaoke nyanyi mic
🎧|headphone|headphone|dengar earphone
📷|kamera|camera|foto photo
📸|kamera blitz|camera with flash|foto photo
💼|tas kerja|briefcase|kerja kantor bisnis work business office
📁|map|file folder|folder berkas
📂|map terbuka|open file folder|folder berkas
🗂|pembatas map|card index dividers|arsip berkas
📄|halaman|page facing up|dokumen berkas document
📝|catatan|memo|tulis catat note memo
📋|papan klip|clipboard|daftar checklist
📌|pin|pushpin|sematkan penting pin
📍|pin bulat|round pushpin|lokasi location
📎|klip kertas|paperclip|lampiran attachment
🖇|klip bersambung|linked paperclips|lampiran attachment
✂|gunting|scissors|potong cut
🖊|pulpen|pen|tulis pena pen
✏|pensil|pencil|tulis sunting edit
📏|penggaris|straight ruler|ukur gambar measure
📐|penggaris segitiga|triangular ruler|desain gambar drafting
📊|grafik batang|bar chart|data laporan chart report
📈|grafik naik|chart increasing|naik tumbuh growth up
📉|grafik turun|chart decreasing|turun down
📅|kalender|calendar|tanggal jadwal date
🗓|kalender spiral|spiral calendar|jadwal agenda schedule
📚|tumpukan buku|books|belajar baca study
📖|buku terbuka|open book|baca read
🏷|label|label|tag harga
📦|paket|package|kirim kotak box delivery
✉|amplop|envelope|surat email mail
📨|surat masuk|incoming envelope|kotak masuk inbox
📤|kotak keluar|outbox tray|kirim outbox
📥|kotak masuk|inbox tray|terima inbox
📞|gagang telepon|telephone receiver|telepon panggil call phone
📱|ponsel|mobile phone|hp handphone phone
💻|laptop|laptop|komputer kerja computer
🖥|komputer meja|desktop computer|pc monitor
🖨|printer|printer|cetak print
⌨|papan ketik|keyboard|ketik keyboard
🖱|tetikus|computer mouse|mouse
🔌|colokan listrik|electric plug|listrik power
💡|lampu|light bulb|ide gagasan idea
🔍|kaca pembesar|magnifying glass tilted left|cari search
🔧|kunci pas|wrench|perbaiki fix tool
🛠|perkakas|hammer and wrench|alat tools
⚙|roda gigi|gear|pengaturan setting
🧰|kotak perkakas|toolbox|alat tools
🔗|tautan|link|link url
🧾|struk|receipt|nota tagihan invoice
💰|kantong uang|money bag|uang duit money
💵|uang kertas|dollar banknote|uang tunai money cash
💳|kartu kredit|credit card|bayar pay
🧹|sapu|broom|bersih clean
🗑|tempat sampah|wastebasket|hapus buang trash delete
🚧|sedang dikerjakan|construction|proyek konstruksi wip
`,
  travel: `
🏠|rumah|house|home
🏢|gedung kantor|office building|kantor office
🏥|rumah sakit|hospital|sakit hospital
🏦|bank|bank|bank
🏫|sekolah|school|school
🏭|pabrik|factory|factory
🏛|gedung pemerintahan|classical building|pemerintah government
🕌|masjid|mosque|mosque
⛪|gereja|church|church
🛕|pura|hindu temple|temple
🏝|pulau|desert island|liburan island
🏖|pantai|beach with umbrella|liburan holiday beach
⛰|gunung|mountain|mountain
🌋|gunung api|volcano|volcano
🗺|peta dunia|world map|peta map
🧭|kompas|compass|arah compass
🚗|mobil|automobile|car
🚕|taksi|taxi|taxi
🚌|bus|bus|bus
🚚|truk|delivery truck|kirim truck
🏍|motor|motorcycle|ojek motorbike
🛵|skuter|motor scooter|ojek motor scooter
🚲|sepeda|bicycle|gowes bike
🚆|kereta|train|krl train
🚇|kereta bawah tanah|metro|mrt subway
✈|pesawat|airplane|terbang dinas plane flight
🛫|lepas landas|airplane departure|berangkat departure
🛬|mendarat|airplane arrival|tiba arrival
🚢|kapal|ship|laut ship
⛽|pom bensin|fuel pump|bensin fuel
🚦|lampu lalu lintas|vertical traffic light|macet traffic
🚀|roket|rocket|meluncur cepat launch
🧳|koper|luggage|perjalanan travel
🌆|kota senja|cityscape at dusk|kota city
⛺|tenda|tent|kemah camping
`,
  flags: `
🇮🇩|bendera indonesia|flag indonesia|indonesia merah putih
🏳|bendera putih|white flag|menyerah surrender
🏴|bendera hitam|black flag|flag
🏁|bendera finis|chequered flag|selesai finish
🚩|bendera segitiga|triangular flag|tandai flag
🎌|bendera bersilang|crossed flags|flags
`,
};

// U+FE0F untuk emoji satu titik kode yang bawaannya tampil sebagai teks.
function withPresentation(char: string): string {
  if (char.includes("️") || [...char].length !== 1) return char;
  return /\p{Emoji_Presentation}/u.test(char) ? char : `${char}️`;
}

function parse(): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const line of RAW[category].split("\n")) {
      if (!line.trim()) continue;
      const [char, id, en, kw = ""] = line.split("|");
      out.push({
        char: withPresentation(char.trim()),
        id: id.trim(),
        en: en.trim(),
        keywords: kw.split(" ").filter(Boolean),
        category,
      });
    }
  }
  return out;
}

export const EMOJI: readonly EmojiEntry[] = parse();

// Huruf kecil, tanpa aksen, garis bawah jadi spasi (":thumbs_up" sama dengan "thumbs up").
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
}

// Kunci pencarian per emoji tanpa U+FE0F, supaya "❤" dan "❤️" dianggap sama.
function charKey(char: string): string {
  return char.replace(/️/g, "");
}

const BY_CHAR = new Map(EMOJI.map((e) => [charKey(e.char), e]));

export function findEmoji(char: string): EmojiEntry | undefined {
  return BY_CHAR.get(charKey(char));
}

export function emojiInCategory(category: EmojiCategory): EmojiEntry[] {
  return EMOJI.filter((e) => e.category === category);
}

export function emojiName(entry: EmojiEntry, lang: "id" | "en"): string {
  return lang === "en" ? entry.en : entry.id;
}

type Indexed = { entry: EmojiEntry; id: string; en: string; words: string[]; keywords: string[] };

const INDEX: Indexed[] = EMOJI.map((entry) => {
  const id = normalizeSearch(entry.id);
  const en = normalizeSearch(entry.en);
  return {
    entry,
    id,
    en,
    words: [...id.split(" "), ...en.split(" ")],
    keywords: entry.keywords.map(normalizeSearch),
  };
});

function rank(item: Indexed, q: string): number {
  if (item.id.startsWith(q) || item.en.startsWith(q)) return 0;
  if (item.words.some((w) => w.startsWith(q)) || item.keywords.some((k) => k.startsWith(q))) return 1;
  if (item.id.includes(q) || item.en.includes(q) || item.keywords.some((k) => k.includes(q))) return 2;
  return -1;
}

// Cari emoji lewat nama Indonesia atau Inggris dan kata kunci. Urutan: awalan
// nama, lalu awalan kata di nama atau kata kunci, lalu potongan kata di mana saja.
// Dalam satu tingkat, urutan data dipertahankan.
export function searchEmoji(query: string, limit = 40): EmojiEntry[] {
  const q = normalizeSearch(query);
  if (!q || limit <= 0) return [];
  const tiers: EmojiEntry[][] = [[], [], []];
  for (const item of INDEX) {
    const r = rank(item, q);
    if (r >= 0) tiers[r].push(item.entry);
  }
  return tiers.flat().slice(0, limit);
}
