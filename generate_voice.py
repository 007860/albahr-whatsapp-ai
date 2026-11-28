#!/usr/bin/env python3
import sys
import os
import re
import asyncio
import subprocess
import tempfile
import edge_tts
import shutil

def get_ffmpeg_binary():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg") or "ffmpeg"

# Urdu Number Names (0 to 99) for authentic Pakistani Lakh / Hazar price speaking!
URDU_NUMS_0_TO_99 = [
    "صفر", "ایک", "دو", "تین", "چار", "پانچ", "چھ", "سات", "آٹھ", "نو",
    "دس", "گیارہ", "بارہ", "تیرہ", "چودہ", "پندرہ", "سولہ", "سترہ", "اٹھارہ", "انیس",
    "بیس", "اکیس", "بائیس", "تئیس", "چوبیس", "پچیس", "چھبیس", "ستائیس", "اٹھائیس", "انتیس",
    "تیس", "اکتیس", "بتیس", "تینتیس", "چونتیس", "پینتیس", "چھتیس", "سینتیس", "اڑتیس", "انتالیس",
    "چالیس", "اکتالیس", "بیالیس", "تینتالیس", "چوالیس", "پینتالیس", "چھیالیس", "سینتالیس", "اڑتالیس", "انچاس",
    "پچاس", "اکیاون", "باون", "ترپن", "چون", "پچپن", "چھپن", "ستاون", "اٹھاون", "انسٹھ",
    "ساٹھ", "اکسٹھ", "باسٹھ", "تریسٹھ", "چوسٹھ", "پینسٹھ", "چھیاسٹھ", "سڑسٹھ", "اڑسٹھ", "انہتر",
    "ستر", "اکہتر", "بہتر", "تہتر", "چوہتر", "پچتر", "چھہتر", "ستتر", "اٹھہتر", "اناسی",
    "اسی", "اکیاسی", "بیاسی", "تراسی", "چوراسی", "پچاسی", "چھیاسی", "ستاسی", "اٹھاسی", "نواسی",
    "نوے", "اکانوے", "بانوے", "ترانوے", "چورانوے", "پچانوے", "چھیانوے", "ستانوے", " اٹھانوے", "ننانوے"
]

def int_to_urdu_words(n):
    if n < 0:
        return str(n)
    if n < 100:
        return URDU_NUMS_0_TO_99[n]
    # Round retail prices ending in 999 (e.g. 273,999 -> 274,000 or 319,999 -> 320,000) OR speak exact Lakh & Hazar cleanly
    if n >= 10000 and (n % 1000 == 999):
        n = n + 1

    parts = []
    if n >= 10000000:
        crores = n // 10000000
        parts.append(f"{int_to_urdu_words(crores)} کروڑ")
        n %= 10000000
    if n >= 100000:
        lakhs = n // 100000
        parts.append(f"{int_to_urdu_words(lakhs)} لاکھ")
        n %= 100000
    if n >= 1000:
        thousands = n // 1000
        parts.append(f"{int_to_urdu_words(thousands)} ہزار")
        n %= 1000
    if n >= 100:
        hundreds = n // 100
        parts.append(f"{int_to_urdu_words(hundreds)} سو")
        n %= 100
    if n > 0:
        parts.append(URDU_NUMS_0_TO_99[n])
    return " ".join(parts)

def convert_numbers_and_prices_to_urdu(text):
    # First protect phone numbers so they aren't read as crores
    t = re.sub(r'0343[-\s]*4762264', 'زیرو تین سو تینتالیس، چار سو چھہتر، بائیس چونسٹھ', text)
    t = re.sub(r'\+92\s*343\s*4762264', 'زیرو تین سو تینتالیس، چار سو چھہتر، بائیس چونسٹھ', t)
    t = re.sub(r'0325[-\s]*7938125', 'زیرو تین سو پچیس، سات سو ترانوے، اکیاسی پچیس', t)

    # Convert comma-formatted or 4-to-7 digit numbers (like 225,000 or 273,999 or 210000) into natural Urdu Lakh/Hazar words!
    def repl_num(m):
        raw = m.group(0).replace(',', '')
        if not raw.isdigit():
            return m.group(0)
        val = int(raw)
        # Skip years like 2025, 2026, 2027
        if 2020 <= val <= 2035:
            return f"دو ہزار {URDU_NUMS_0_TO_99[val - 2000]}"
        if val <= 99999999:
            return int_to_urdu_words(val)
        return m.group(0)

    t = re.sub(r'\b\d{1,3}(?:,\d{3})+\b|\b\d{1,7}\b', repl_num, t)
    return t

ROMAN_TO_URDU_MAP = {
    "assalam": "السلام", "alaikum": "علیکم", "walaikum": "وعلیکم", "salam": "سلام",
    "aoa": "السلام علیکم", "jee": "جی", "ji": "جی", "haan": "ہاں", "han": "ہاں",
    "nahi": "نہیں", "nai": "نہیں", "sir": "سر", "madam": "میڈم",
    "mohtarma": "محترمہ", "mohterma": "محترمہ", "bhai": "بھائی", "jaan": "جان",
    "main": "میں", "mein": "میں", "ma": "میں", "ap": "آپ", "aap": "آپ",
    "aapka": "آپ کا", "apka": "آپ کا", "aapki": "آپ کی", "apki": "آپ کی",
    "aapke": "آپ کے", "apke": "آپ کے", "aapko": "آپ کو", "apko": "آپ کو",
    "hum": "ہم", "hamara": "ہمارا", "hamari": "ہماری", "hamaray": "ہمارے", "hamare": "ہمارے",
    "mera": "میرا", "meri": "میری", "mere": "میرے", "mujhe": "مجھے", "mujy": "مجھے",
    "ka": "کا", "ki": "کی", "ke": "کے", "ky": "کے", "k": "کے", "ko": "کو",
    "se": "سے", "sy": "سے", "ne": "نے", "par": "پر", "pe": "پہ", "py": "پہ",
    "aur": "اور", "or": "اور", "ya": "یا", "hai": "ہے", "hain": "ہیں", "ha": "ہے",
    "ho": "ہو", "hoon": "ہوں", "hun": "ہوں", "tha": "تھا", "thi": "تھی", "thay": "تھے",
    "ga": "گا", "gi": "گی", "ge": "گے", "gy": "گے", "kya": "کیا", "kis": "کس",
    "kon": "کون", "kaun": "کون", "kab": "کب", "kahan": "کہاں", "kesy": "کیسے", "kaise": "کیسے",
    "kitna": "کتنا", "kitne": "کتنے", "kitni": "کتنی", "ye": "یہ", "yeh": "یہ",
    "wo": "وہ", "woh": "وہ", "is": "اِس", "us": "اُس", "in": "اِن", "un": "اُن",
    "jo": "جو", "jab": "جب", "tab": "تب", "ab": "اب", "abhi": "ابھی", "aaj": "آج", "kal": "کل",
    "din": "دن", "nights": "راتیں", "night": "رات", "mahina": "مہینہ", "mahinay": "مہینے",
    "saal": "سال", "waqt": "وقت", "time": "ٹائم", "baat": "بات", "bat": "بات",
    "kar": "کر", "kr": "کر", "karein": "کریں", "karen": "کریں",
    "karta": "کرتا", "karti": "کرتی", "karte": "کرتے", "karna": "کرنا", "krna": "کرنا",
    "raha": "رہا", "rahi": "رہی", "rahe": "رہے", "rahay": "رہے",
    "sakta": "سکتا", "sakti": "سکتی", "sakte": "سکتے", "saktay": "سکتے",
    "chahiye": "چاہیے", "chahye": "چاہیے", "chahte": "چاہتے", "chahti": "چاہتی",
    "de": "دے", "do": "دو", "dein": "دیں", "den": "دیں", "doon": "دوں", "dunga": "دوں گا",
    "le": "لے", "lo": "لو", "lein": "لیں", "len": "لیں",
    "bata": "بتا", "batao": "بتاؤ", "batayen": "بتائیں", "bataein": "بتائیں",
    "bhej": "بھیج", "bhejo": "بھیجو", "bhejein": "بھیجیں", "send": "بھیج",
    "share": "شیئر", "check": "چیک", "guide": "گائیڈ", "help": "مدد", "madad": "مدد",
    "bilkul": "بالکل", "zaroor": "ضرور", "bohot": "بہت", "bahut": "بہت",
    "acha": "اچھا", "achi": "اچھی", "achay": "اچھے", "theek": "ٹھیک", "thik": "ٹھیک",
    "behtareen": "بہترین", "best": "بہترین", "sab": "سب", "sara": "سارا", "sari": "ساری",
    "puri": "پوری", "pura": "پورا", "mukammal": "مکمل", "tafseel": "تفصیل",
    "details": "تفصیلات", "detail": "تفصیل", "information": "معلومات", "info": "معلومات",
    "kharcha": "خرچہ", "cost": "لاگت", "price": "قیمت", "rate": "ریٹ", "rates": "ریٹس",
    "fee": "فیس", "fees": "فیس", "paise": "پیسے", "paisay": "پیسے",
    "discount": "ڈسکاؤنٹ", "special": "خصوصی", "priority": "پرائیورٹی", "vip": "وی آئی پی",
    "slot": "سیٹ", "slots": "سیٹیں", "seat": "سیٹ", "seats": "سیٹیں", "batch": "گروپ",
    "lock": "بُک", "reserve": "بُک", "book": "بُک", "booking": "بکنگ", "confirm": "کنفرم",
    "file": "فائل", "files": "فائلز", "passport": "پاسپورٹ", "photo": "تصویر",
    "picture": "تصویر", "pic": "تصویر", "tasveer": "تصویر", "poster": "پوسٹر", "posters": "پوسٹرز",
    "pdf": "فائل", "document": "دستاویز", "documents": "کاغذات",
    "visa": "ویزا", "visas": "ویزے", "visit": "وزٹ", "work": "ورک", "permit": "پرمٹ",
    "job": "جاب", "jobs": "جابز", "study": "سٹڈی", "student": "سٹوڈنٹ",
    "university": "یونیورسٹی", "admission": "ایڈمیشن", "scholarship": "سکالرشپ",
    "umrah": "عمرہ", "hajj": "حج", "package": "پیکج", "packages": "پیکجز",
    "hotel": "ہوٹل", "hotels": "ہوٹلز", "ticket": "ٹکٹ", "tickets": "ٹکٹس",
    "ticketing": "ٹکٹنگ", "flight": "فلائٹ", "airline": "ایئر لائن", "airlines": "ایئر لائن",
    "saudia": "سعودیہ ایئر لائن", "fly": "فلائی", "jinnah": "جناح", "pia": "پی آئی اے",
    "sharing": "شیئرنگ روم", "quad": "چار بیڈ روم", "triple": "تین بیڈ روم", "double": "ڈبل بیڈ روم",
    "meter": "میٹر", "shuttle": "شٹل سروس",
    "medical": "میڈیکل", "gamca": "گیمکا", "wafid": "وافد", "token": "ٹوکن",
    "appointment": "اپوائنٹمنٹ", "embassy": "ایمبیسی", "iqama": "اقامہ", "kafeel": "کفیل",
    "sponsor": "سپانسر", "wakala": "وکالہ", "protector": "پروٹیکٹر", "etimad": "اعتماد",
    "biometrics": "بائیو میٹرکس", "azad": "آزاد", "saudi": "سعودی", "arabia": "عرب",
    "makkah": "مکہ مکرمہ", "madina": "مدینہ منورہ", "madinah": "مدینہ منورہ",
    "lahore": "لاہور", "pakistan": "پاکستان", "islamabad": "اسلام آباد", "karachi": "کراچی",
    "jeddah": "جدہ", "lhe": "لاہور", "jed": "جدہ",
    "dubai": "دبئی", "uae": "یو اے ای", "qatar": "قطر", "kuwait": "کویت", "oman": "عمان",
    "bahrain": "بحرین", "turkey": "ترکی", "poland": "پولینڈ", "albania": "البانیہ",
    "europe": "یورپ", "schengen": "شینگن", "germany": "جرمنی", "italy": "اٹلی",
    "hungary": "ہنگری", "china": "چین", "korea": "کوریا", "uk": "یو کے", "usa": "یو ایس اے",
    "malaysia": "ملائیشیا", "thailand": "تھائی لینڈ",
    "ali": "علی", "ahmad": "احمد", "ahmed": "احمد", "company": "کمپنی",
    "registered": "رجسٹرڈ", "office": "آفس", "society": "سوسائٹی", "block": "بلاک",
    "call": "کال", "whatsapp": "واٹس ایپ", "voice": "وائس", "note": "نوٹ",
    "message": "میسج", "number": "نمبر", "shukriya": "شکریہ",
    "inshaallah": "ان شاء اللہ", "alhamdulillah": "الحمد للہ", "mashallah": "ما شاء اللہ",
    "allah": "اللہ", "pak": "پاک", "dil": "دل", "pyar": "پیار", "muhabbat": "محبت",
    "shadi": "شادی", "nikah": "نکاح", "family": "فیملی", "ghar": "گھر",
    "rasta": "راستہ", "tarika": "طریقہ", "tariqa": "طریقہ", "masla": "مسئلہ",
    "pareshan": "پریشان", "fikar": "فکر", "befikar": "بے فکر", "sath": "ساتھ",
    "lihaz": "لحاظ", "tarah": "طرح", "jaisa": "جیسا", "jaise": "جیسے", "jasy": "جیسے",
    "taake": "تاکہ", "kyunke": "کیونکہ", "lekin": "لیکن", "magar": "مگر",
    "agar": "اگر", "phir": "پھر", "to": "تو", "bhi": "بھی", "bhe": "بھی",
    "hi": "ہی", "he": "ہی", "sirf": "صرف", "kuch": "کچھ", "koi": "کوئی",
    "har": "ہر", "her": "ہر", "ek": "ایک", "aik": "ایک", "doosra": "دوسرا",
    "pehle": "پہلے", "baad": "بعد", "andar": "اندر", "upar": "اوپر", "neechay": "نیچے",
    "deec": "دسمبر", "dec": "دسمبر", "december": "دسمبر", "nov": "نومبر", "november": "نومبر",
    "january": "جنوری", "february": "فروری", "march": "مارچ", "april": "اپریل",
    "group": "گروپ", "pkg": "پیکج نمبر", "demand": "ڈیمانڈ", "tourism": "ٹورزم",
    "european": "یورپین", "others": "دیگر", "emerald": "ایمرلڈ", "partnership": "پارٹنرشپ",
    "congratulations": "مبارکباد", "card": "کارڈ", "png": "", "jpg": "", "jpeg": "",
    "docx": "", "apk": "ایپ", "cnic": "شناختی کارڈ", "cs": "کمپیوٹر سائنس",
    "it": "آئی ٹی", "cgpa": "سی جی پی اے", "misa": "میسا", "ibcc": "آئی بی سی سی",
    "mofa": "موفا", "sar": "سعودی ریال", "pkr": "روپے", "rs": "روپے",
    "process": "پراسیس", "save": "محفوظ", "saved": "محفوظ", "paas": "پاس", "pas": "پاس",
    "snapshot": "تصویر", "snapchat": "تصویر", "case": "کیس", "list": "لسٹ",
    "category": "کیٹیگری", "limited": "محدود", "status": "سٹیٹس", "online": "آن لائن",
    "direct": "ڈائریکٹ", "urgent": "ارجنٹ", "fast": "فاسٹ", "track": "ٹریک",
    "desk": "ڈیسک", "team": "ٹیم", "client": "کلائنٹ", "owner": "اونر", "ceo": "سی ای او",
    "mubashir": "مبشر", "mubashar": "مبشر", "hatim": "حاتم", "junaid": "جنید",
    "ramadan": "رمضان", "ramzan": "رمضان",
    "greece": "گریس", "greek": "گریس", "vfs": "وی ایف ایس", "global": "گلوبل",
    "bls": "بی ایل ایس", "gerrys": "جیریز", "gerry": "جیریز", "tasheel": "تسہیل",
    "qiwa": "قویٰ", "muqeem": "مقیم", "frc": "ایف آر سی", "ntn": "این ٹی این",
    "bank": "بینک", "statement": "سٹیٹمنٹ", "insurance": "انشورنس",
    "travel": "ٹریول", "travels": "ٹریولز", "horizon": "ہورائزن", "consultants": "کنسلٹنٹس"
}

def convert_roman_urdu_to_urdu_script(text):
    t = text
    t = re.sub(
        r'\bAL[-\s]*BAHR\s+HORIZON\s+TRAVELS\s*(&|AND)\s*CONSULTANTS\b',
        'ال بحر، ہورائزن ٹریولز اینڈ کنسلٹنٹس',
        t,
        flags=re.IGNORECASE
    )
    t = re.sub(
        r'\bAL[-\s]*BAHR\s+HORIZON\s+TRAVELS\b',
        'ال بحر، ہورائزن ٹریولز',
        t,
        flags=re.IGNORECASE
    )
    t = re.sub(
        r'\bAL[-\s]*BAHR\s+TRAVELS\b',
        'ال بحر، ٹریولز',
        t,
        flags=re.IGNORECASE
    )
    t = re.sub(r'\bAL[-\s]*BAHR\b', 'ال بحر،', t, flags=re.IGNORECASE)
    t = re.sub(r'\bHORIZON\s+TRAVELS\b', 'ہورائزن ٹریولز', t, flags=re.IGNORECASE)
    t = re.sub(r'\bCONSULTANTS\b', 'کنسلٹنٹس', t, flags=re.IGNORECASE)
    t = re.sub(r'\bSECP\b', 'ایس ای سی پی', t, flags=re.IGNORECASE)

    t = t.replace('_', ' ').replace('#', ' نمبر ')
    t = re.sub(r'\.(pdf|png|jpg|jpeg|docx|apk)\b', '', t, flags=re.IGNORECASE)
    t = re.sub(r'Note:\s*I[\'’]?m Ali Ahmad[\s\S]*$', '', t, flags=re.IGNORECASE)

    # Convert numbers & prices into proper Urdu Lakh / Hazar words!
    t = convert_numbers_and_prices_to_urdu(t)

    def replace_word(match):
        w = match.group(0)
        low = w.lower()
        if low in ROMAN_TO_URDU_MAP:
            return ROMAN_TO_URDU_MAP[low]
        s = low
        s = s.replace('sh', 'ش').replace('ch', 'چ').replace('kh', 'خ').replace('gh', 'غ').replace('ph', 'ف').replace('th', 'تھ').replace('bh', 'بھ').replace('dh', 'دھ').replace('rh', 'ڑھ').replace('aa', 'ا').replace('ee', 'ی').replace('oo', 'و').replace('ou', 'و').replace('ai', 'ے').replace('ay', 'ے')
        char_map = {
            'a': 'ا', 'b': 'ب', 'c': 'ک', 'd': 'ڈ', 'e': 'ی', 'f': 'ف', 'g': 'گ',
            'h': 'ہ', 'i': 'ی', 'j': 'ج', 'k': 'ک', 'l': 'ل', 'm': 'م', 'n': 'ن',
            'o': 'و', 'p': 'پ', 'q': 'ق', 'r': 'ر', 's': 'س', 't': 'ٹ', 'u': 'و',
            'v': 'و', 'w': 'و', 'x': 'کس', 'y': 'ی', 'z': 'ز'
        }
        return ''.join(char_map.get(ch, ch) for ch in s)

    t = re.sub(r'[a-zA-Z]+', replace_word, t)
    return t

def prepare_text_for_tts(text, lang_mode):
    clean = text
    # Strip any trailing [[ALI_ACTION or [[LEAD_STATUS block even if unclosed!
    clean = re.sub(r'\[\[(?:ALI_ACTION|LEAD_STATUS)[\s\S]*$', '', clean)
    clean = re.sub(r'\*+|_+|#+|`+|~+', '', clean)
    clean = re.sub(r'\(\s*Sir\s*\)', '', clean, flags=re.IGNORECASE)
    # Remove ALL parenthetical notes (...) so TTS never reads out English/extra words in brackets!
    clean = re.sub(r'\([^)]*\)', ' ', clean)
    clean = re.sub(r'\[[^\]]*\]', ' ', clean)
    clean = re.sub(r'https?://\S+', '', clean)
    clean = re.sub(r'www\.albahrtravels\.com', 'ال بحر، ٹریولز ڈاٹ کام', clean, flags=re.IGNORECASE)
    clean = re.sub(r'albahrtravels\.com', 'ال بحر، ٹریولز ڈاٹ کام', clean, flags=re.IGNORECASE)
    clean = re.sub(r'\bAlBahr_[A-Za-z0-9_]+\.(png|pdf|jpg)\b', ' ', clean, flags=re.IGNORECASE)
    clean = re.sub(r'[1-9]️⃣|[•✅✈️🕋🏥💼🎓🎫📋👤📱🎯💬🧑‍💼📎🌐📍🙏❤️🤝👋🌟📄🎤📞]', ' ', clean)

    # Replace slashes (/), colons (:), bullets (-), and symbols with natural human spoken connectors ("یا" / "or" / comma)
    if "PURE_ENGLISH" in lang_mode and not re.search(r'[\u0600-\u06FF]', clean):
        clean = re.sub(r'\s*/\s*', ' or ', clean)
    else:
        clean = re.sub(r'\s*/\s*', ' یا ', clean)

    clean = re.sub(r'[:;•|]+', '، ', clean)
    clean = re.sub(r'(^|\n)\s*[-–—]+\s*', ' ', clean)

    clean = clean.replace('اَل بَحر', 'ال بحر،')
    clean = clean.replace('اَلبَحر', 'ال بحر،')
    clean = clean.replace('البجر', 'ال بحر،')
    clean = clean.replace('البحر', 'ال بحر،')
    clean = clean.replace('ال بحر ', 'ال بحر، ')
    clean = clean.replace('سنیپ شاٹ', 'تصویر')
    clean = clean.replace('سنیپ چیٹ', 'تصویر')
    clean = clean.replace('،،', '،')

    if "PURE_ENGLISH" in lang_mode and not re.search(r'[\u0600-\u06FF]', clean):
        clean = re.sub(
            r'\bAL[-\s]*BAHR\s+HORIZON\s+TRAVELS\s*(&|AND)\s*CONSULTANTS\b',
            'Al Bahr Horizon Travels and Consultants',
            clean,
            flags=re.IGNORECASE
        )
        clean = re.sub(
            r'\bAL[-\s]*BAHR\s+HORIZON\s+TRAVELS\b',
            'Al Bahr Horizon Travels',
            clean,
            flags=re.IGNORECASE
        )
        clean = re.sub(r'\bAL[-\s]*BAHR\s+TRAVELS\b', 'Al Bahr Travels', clean, flags=re.IGNORECASE)
        clean = re.sub(r'\bAL[-\s]*BAHR\b', 'Al Bahr', clean, flags=re.IGNORECASE)
        clean = re.sub(r'\bSECP\b', 'S E C P', clean)
    else:
        clean = convert_roman_urdu_to_urdu_script(clean)

    clean = clean.replace('—', '، ').replace('–', '، ').replace('➔', '، ').replace('...', '، ')
    clean = re.sub(r'\s+', ' ', clean).strip()

    if len(clean) > 950:
        clean = clean[:950]

    return clean

async def make_voice(text, lang_mode, out_ogg_path):
    clean = prepare_text_for_tts(text, lang_mode)
    has_urdu_script = bool(re.search(r'[\u0600-\u06FF]', clean))

    if has_urdu_script or "URDU" in lang_mode:
        voice = "ur-PK-AsadNeural"
        rate = "+0%"
        pitch = "-1Hz"
    else:
        voice = "en-US-AndrewMultilingualNeural"
        rate = "-2%"
        pitch = "-1Hz"

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp_mp3:
        mp3_path = tmp_mp3.name

    try:
        communicate = edge_tts.Communicate(clean, voice, rate=rate, pitch=pitch)
        await communicate.save(mp3_path)

        ffmpeg_exe = get_ffmpeg_binary()
        subprocess.run(
            [
                ffmpeg_exe, "-y", "-i", mp3_path,
                "-af", (
                    "highpass=f=85,"
                    "lowpass=f=9500,"
                    "equalizer=f=175:width_type=o:width=1.2:g=2.5,"
                    "equalizer=f=2800:width_type=o:width=1.5:g=1.5,"
                    "equalizer=f=6500:width_type=o:width=1.0:g=-2.0,"
                    "acompressor=threshold=-16dB:ratio=2.5:attack=15:release=150:makeup=2dB"
                ),
                "-ar", "48000", "-ac", "1",
                "-c:a", "libopus", "-b:a", "40k", "-vbr", "on",
                "-compression_level", "10", "-frame_duration", "20", "-application", "voip",
                out_ogg_path
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True
        )
        print("OK")
    finally:
        if os.path.exists(mp3_path):
            os.remove(mp3_path)

if __name__ == "__main__":
    if len(sys.argv) >= 4:
        asyncio.run(make_voice(sys.argv[1], sys.argv[2], sys.argv[3]))
