#!/usr/bin/env python3
import sys
import os
import re
from PIL import Image, ImageDraw, ImageFont

TEMPLATE_POSTER = "/home/test/Downloads/AL-BAHR_All_24_Umrah_Posters/Umrah_Group_01_PKG_728.png"
FONT_SERIF_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"
FONT_SANS_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_SANS_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

# Authentic Al-Bahr Travels Knowledge Base for Poster Generation (100% Real Services & Requirements — NO fake prices!)
POSTER_PROFILES = {
    "schengen": {
        "badge": "OFFICIAL VISA CONSULTANCY  •  SECP REGISTERED",
        "title": "Schengen / Europe Visa",
        "subtitle": "GERMANY • ITALY • FRANCE • SPAIN • NETHERLANDS • POLAND",
        "tagline": "COMPLETE EMBASSY FILE PREPARATION  •  APPOINTMENT PIPELINE",
        "banner_left": "SERVICE CATEGORY",
        "banner_right": "Visit & Business Visa",
        "section1_title": "INCLUDED CONSULTANCY SERVICES",
        "section1_rows": [
            ("Embassy Appointment", "VFS / BLS / Embassy Slot Booking", "Included"),
            ("Visa File & Cover Letter", "Embassy-Grade Documentation & Itinerary", "Included"),
            ("Flight & Hotel Routing", "Verified Travel Insurance & Reservations", "Included")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Original Passport (Clear Scan/Photo — Min. 6 Months Validity)",
            "2. Valid CNIC (Front & Back) + 2 White-Background Visa Photos",
            "3. Last 6 Months Bank Statement & Account Maintenance Certificate",
            "4. FRC (Family Registration), NTN / Tax Returns & Job/Business Proof"
        ],
        "footer_note": "100% Transparent Process  •  Free Initial Profile Assessment"
    },
    "uk": {
        "badge": "OFFICIAL VISA CONSULTANCY  •  SECP REGISTERED",
        "title": "United Kingdom (UK) Visa",
        "subtitle": "STANDARD VISITOR  •  BUSINESS  •  FAMILY VISIT VISA",
        "tagline": "EMBASSY-GRADE UKVI FILE PREPARATION & APPOINTMENT",
        "banner_left": "SERVICE CATEGORY",
        "banner_right": "UK Visit & Business",
        "section1_title": "INCLUDED CONSULTANCY SERVICES",
        "section1_rows": [
            ("UKVI Online Application", "Complete Form Filing & Document Upload", "Included"),
            ("VFS Global Biometrics", "Lahore / Islamabad Appointment Booking", "Included"),
            ("Cover Letter & Tie Proof", "Strong Financial & Home-Ties Representation", "Included")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Original Passport (Min. 6 Months Validity) & Valid CNIC Copy",
            "2. White-Background Photograph & Family Registration Certificate (FRC)",
            "3. Last 6 Months Bank Statement + Account Maintenance Letter",
            "4. NTN / Income Tax Returns, Salary Slips / Business Documents"
        ],
        "footer_note": "SECP Registered Consultancy  •  Lahore Head Office"
    },
    "usa": {
        "badge": "OFFICIAL VISA CONSULTANCY  •  SECP REGISTERED",
        "title": "USA B1/B2 Visit Visa",
        "subtitle": "TOURISM  •  BUSINESS  •  CONFERENCE  •  FAMILY VISIT",
        "tagline": "DS-160 EXPERT FILING  •  INTERVIEW PREPARATION & SLOT",
        "banner_left": "SERVICE CATEGORY",
        "banner_right": "USA B1/B2 Consultancy",
        "section1_title": "INCLUDED CONSULTANCY SERVICES",
        "section1_rows": [
            ("DS-160 Precision Filing", "Strategic Profile & Travel History Framing", "Included"),
            ("Embassy Appointment", "Islamabad / Karachi Interview Scheduling", "Included"),
            ("1-on-1 Mock Interview", "Complete Visa Officer Question Preparation", "Included")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Original Passport (Current + Previous Passports if any)",
            "2. Valid CNIC Copy & 1 US-Size (2x2 inch) White Background Photo",
            "3. Last 6 Months Bank Statement, FRC & Property/Business Ties",
            "4. Employment Letter / Salary Slips or Business NTN & Chamber Card"
        ],
        "footer_note": "Expert Embassy Interview Guidance  •  Al-Bahr Horizon Travels"
    },
    "turkey": {
        "badge": "OFFICIAL VISA & WORK PERMITS  •  SECP REGISTERED",
        "title": "Turkey Visit & Work Visa",
        "subtitle": "ISTANBUL  •  ANKARA  •  ANTALYA  •  TOURIST & WORK PATHWAYS",
        "tagline": "ANATOLIA APPOINTMENT  •  HOTEL & FLIGHT ROUTING",
        "banner_left": "SERVICE CATEGORY",
        "banner_right": "Turkey Visa Services",
        "section1_title": "INCLUDED CONSULTANCY SERVICES",
        "section1_rows": [
            ("Anatolia Visa File", "Complete Checklist, Polio & Travel Insurance", "Included"),
            ("Flight & Hotel Booking", "Confirmed Itinerary & Cover Letter", "Included"),
            ("Work Permit Guidance", "Legal Turkish Work & Study Pathways", "Available")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Original Passport (Min. 6 Months Validity) & CNIC Copy",
            "2. 2 Biometric White-Background Photos (5x5 cm) & Polio Certificate",
            "3. Last 6 Months Bank Statement & Account Maintenance Certificate",
            "4. FRC, NTN / Job Letter or Business Proof"
        ],
        "footer_note": "Fast-Track File Preparation  •  Lahore Office"
    },
    "study": {
        "badge": "INTERNATIONAL EDUCATION DESK  •  SECP REGISTERED",
        "title": "Study Abroad Consultancy",
        "subtitle": "GERMANY • ITALY • HUNGARY • CHINA • SOUTH KOREA • TURKEY",
        "tagline": "ADMISSIONS  •  SCHOLARSHIPS  •  EMBASSY VISA FILING",
        "banner_left": "ELIGIBILITY",
        "banner_right": "BS / MS / Scholarship",
        "section1_title": "END-TO-END STUDENT SERVICES",
        "section1_rows": [
            ("University Admissions", "Shortlisting & Offer Letter Processing", "Included"),
            ("Scholarship & Stipend", "CSC / GKS / DSU Italy / Stipendium Guidance", "Included"),
            ("Visa & Blocked Account", "Embassy Interview, SOP & File Preparation", "Included")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Original Passport, CNIC Copy & White-Background Photograph",
            "2. Academic Transcripts & Degrees (Matric, Inter, BS/Transcript)",
            "3. CV, Statement of Purpose (SOP) & 2 Recommendation Letters",
            "4. English Proficiency Certificate / IELTS (as per university rule)"
        ],
        "footer_note": "Free Profile & CGPA Evaluation  •  Al-Bahr Horizon Travels"
    },
    "work": {
        "badge": "OVERSEAS EMPLOYMENT & IQAMA  •  SECP REGISTERED",
        "title": "Work Visa & Saudi Iqama",
        "subtitle": "SAUDI ARABIA (KSA) • QATAR • UAE • POLAND • ALBANIA • TURKEY",
        "tagline": "WAKALA STAMPING  •  GAMCA WAFID MEDICAL  •  PROTECTOR",
        "banner_left": "SERVICE CATEGORY",
        "banner_right": "Work Permit & Iqama",
        "section1_title": "COMPLETE WORK VISA LOGISTICS",
        "section1_rows": [
            ("Saudi Work Visa / Iqama", "Wakala, E-Number & Embassy Stamping", "Fast-Track"),
            ("GAMCA / Wafid Medical", "Instant Online Medical Token Booking", "Same Day"),
            ("Etimad & Protector", "Biometrics & Protector of Emigrants Lahore", "Included")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Clear Picture of Original Passport (Min. 8 Months Validity)",
            "2. Clear Picture of Valid CNIC (Front & Back)",
            "3. White-Background Passport Size Photograph",
            "4. Educational Degree / Diploma / Skill Certificate & Previous Visa (if any)"
        ],
        "footer_note": "Verified Corporate Sponsors  •  100% Legal Embassy Processing"
    },
    "medical": {
        "badge": "INSTANT ONLINE TOKEN DESK  •  SECP REGISTERED",
        "title": "GAMCA / Wafid Medical",
        "subtitle": "SAUDI ARABIA • QATAR • UAE • KUWAIT • OMAN • BAHRAIN",
        "tagline": "INSTANT WAFID MEDICAL APPOINTMENT SLIP  •  ALL PAKISTAN CITIES",
        "banner_left": "PROCESSING TIME",
        "banner_right": "Instant Online Token",
        "section1_title": "MEDICAL APPOINTMENT SERVICES",
        "section1_rows": [
            ("Wafid / GAMCA Slip", "Official Gulf Approved Medical Center Token", "Instant"),
            ("Cities Covered", "Lahore, Islamabad, Karachi, Multan, Peshawar", "All Cities"),
            ("Visa Categories", "Work Visa, Family Residence & Iqama Medical", "Supported")
        ],
        "section2_title": "REQUIRED DETAILS TO GENERATE TOKEN NOW",
        "section2_bullets": [
            "1. Clear Picture of Original Passport (First Page)",
            "2. Clear Picture of Valid CNIC",
            "3. Destination Country (Saudi Arabia, Qatar, UAE, Oman, Kuwait, Bahrain)",
            "4. Visa Type (Work / Family) & City in Pakistan for Medical Test"
        ],
        "footer_note": "Send Passport Photo on WhatsApp 0343-4762264 for Instant Slip"
    },
    "gulf": {
        "badge": "GULF & ASIA VISIT VISAS  •  SECP REGISTERED",
        "title": "Gulf & Asia Visit Visas",
        "subtitle": "SAUDI ARABIA • UAE / DUBAI • QATAR • MALAYSIA • THAILAND",
        "tagline": "TOURIST VISAS  •  FAMILY VISIT  •  UMRAH & AIR TICKETING",
        "banner_left": "PROCESSING",
        "banner_right": "Fast E-Visa & Stamping",
        "section1_title": "AVAILABLE VISA & TRAVEL SERVICES",
        "section1_rows": [
            ("UAE / Qatar / KSA Visit", "30 / 60 / 90 Days Tourist & Family Visas", "Fast-Track"),
            ("Malaysia & Thailand", "E-Visa & Sticker Visa File Processing", "Included"),
            ("Direct Air Ticketing", "Lowest Group Fares & Hotel Reservations", "Available")
        ],
        "section2_title": "OFFICIAL REQUIRED DOCUMENTS FROM CLIENT",
        "section2_bullets": [
            "1. Clear Picture of Original Passport (Min. 6 Months Validity)",
            "2. Clear Picture of Valid CNIC (Front & Back)",
            "3. 1 Fresh Passport-Size Photograph with White Background",
            "4. Bank Statement / Travel History (if required for destination)"
        ],
        "footer_note": "One-Stop Travel & Visa Desk  •  Al-Bahr Horizon Travels Lahore"
    },
    "umrah": {
        "badge": "DECEMBER & RAMADAN OPERATIONS  •  SECP REGISTERED",
        "title": "Umrah Packages 2026",
        "subtitle": "14 & 20 NIGHTS  •  DIRECT SAUDIA / FLY JINNAH / PIA FLIGHTS",
        "tagline": "MAKKAH & MADINAH HOTELS  •  VISA  •  TRANSPORT INCLUDED",
        "banner_left": "STARTING FROM",
        "banner_right": "PKR 210,000 - 273,999",
        "section1_title": "OFFICIAL UMRAH PACKAGE TIERS (LAHORE -> JEDDAH)",
        "section1_rows": [
            ("Budget Economy Package", "Visa + Return Ticket + Shuttle Hotels", "210k - 225k"),
            ("20-Nights Group Package", "12N Makkah + 8N Madinah (Sharing/Quad)", "273,999"),
            ("14-Nights Near Haram", "500m Walking Distance Makkah & Madinah", "292,999")
        ],
        "section2_title": "REQUIRED DOCUMENTS FOR UMRAH BOOKING",
        "section2_bullets": [
            "1. Clear Picture of Original Passport (Min. 6-8 Months Validity)",
            "2. Clear Picture of Valid CNIC (Front & Back)",
            "3. 1 Fresh Passport-Size Photograph (White or Blue Background)",
            "4. Contact Number & Preferred Travel Dates / Room Type"
        ],
        "footer_note": "Economy & VIP Custom Packages Available  •  Lahore Head Office"
    }
}

def pick_profile(query):
    q = (query or "").lower()
    if any(k in q for k in ["schengen", "europe", "greece", "greek", "france", "spain", "netherlands", "belgium", "switzerland", "شینگن", "شنگن", "یورپ", "گریس", "گریز", "یونان", "فرانس", "سپین"]):
        return POSTER_PROFILES["schengen"], "AlBahr_Schengen_Europe_Visa_Poster.png"
    if any(k in q for k in ["uk", "united kingdom", "london", "england", "britain", "یو کے", "لندن", "برطانیہ", "انگلینڈ"]):
        return POSTER_PROFILES["uk"], "AlBahr_UK_Visit_Visa_Poster.png"
    if any(k in q for k in ["usa", "america", "united states", "us visa", "b1", "b2", "امریکہ", "یو ایس اے"]):
        return POSTER_PROFILES["usa"], "AlBahr_USA_Visit_Visa_Poster.png"
    if any(k in q for k in ["turkey", "turkiye", "istanbul", "ankara", "ترکی", "استنبول"]):
        return POSTER_PROFILES["turkey"], "AlBahr_Turkey_Visa_Poster.png"
    if any(k in q for k in ["study", "student", "university", "scholarship", "cgpa", "germany", "italy", "hungary", "china", "korea", "سٹڈی", "یونیورسٹی", "سکالرشپ", "جرمنی", "اٹلی", "ہنگری", "چین", "کوریا"]):
        return POSTER_PROFILES["study"], "AlBahr_Study_Abroad_Consultancy_Poster.png"
    if any(k in q for k in ["medical", "gamca", "wafid", "token", "میڈیکل", "گیمکا", "وافد", "ٹوکن"]):
        return POSTER_PROFILES["medical"], "AlBahr_GAMCA_Wafid_Medical_Token_Poster.png"
    if any(k in q for k in ["iqama", "akama", "kama", "work", "job", "labour", "kafeel", "wakala", "poland", "albania", "permit", "اقامہ", "اقامے", "ورک", "کفیل", "وکالہ", "آزاد", "جاب", "پولینڈ", "البانیہ"]):
        return POSTER_PROFILES["work"], "AlBahr_Work_Visa_And_Iqama_Poster.png"
    if any(k in q for k in ["dubai", "uae", "qatar", "kuwait", "oman", "bahrain", "malaysia", "thailand", "visit", "ticket", "flight", "دبئی", "قطر", "کویت", "عمان", "بحرین", "ملائیشیا", "تھائی لینڈ", "وزٹ", "ٹکٹ"]):
        return POSTER_PROFILES["gulf"], "AlBahr_Visit_Visa_And_Ticketing_Poster.png"
    return POSTER_PROFILES["umrah"], "AlBahr_Umrah_Packages_Overview_Poster.png"

def generate_poster(query, out_dir):
    profile, filename = pick_profile(query)
    out_path = os.path.join(out_dir, filename)

    # Use Al-Bahr's official poster header & footer from Umrah_Group_01_PKG_728.png (1080x1920)
    if os.path.exists(TEMPLATE_POSTER):
        img = Image.open(TEMPLATE_POSTER).convert("RGB")
    else:
        img = Image.new("RGB", (1080, 1920), (8, 43, 66))

    draw = ImageDraw.Draw(img)

    # 1. Paint dark navy center badge box (y=428 to 656, x=65 to 1015) keeping gold border intact
    draw.rounded_rectangle([65, 428, 1015, 656], radius=24, fill=(8, 43, 66))

    # 2. Paint warm cream middle body area (y=680 to 1620, x=0 to 1080)
    draw.rectangle([0, 680, 1080, 1620], fill=(252, 250, 242))

    # Fonts
    f_badge = load_font(FONT_SANS_BOLD, 24)
    f_title = load_font(FONT_SERIF_BOLD, 66)
    f_sub = load_font(FONT_SANS_BOLD, 28)
    f_tag = load_font(FONT_SANS_BOLD, 22)

    f_ban_l = load_font(FONT_SANS_BOLD, 26)
    f_ban_r = load_font(FONT_SERIF_BOLD, 48)

    f_sec = load_font(FONT_SANS_BOLD, 26)
    f_row_b = load_font(FONT_SANS_BOLD, 26)
    f_row_r = load_font(FONT_SANS_REG, 24)
    f_doc = load_font(FONT_SANS_BOLD, 25)

    # Draw Center Navy Box Text
    draw.text((540, 460), profile["badge"], fill=(224, 192, 128), font=f_badge, anchor="mm")
    draw.text((540, 525), profile["title"], fill=(255, 255, 255), font=f_title, anchor="mm")
    draw.text((540, 590), profile["subtitle"], fill=(255, 255, 255), font=f_sub, anchor="mm")
    draw.text((540, 632), profile["tagline"], fill=(224, 192, 128), font=f_tag, anchor="mm")

    # 3. Gold Highlight Banner (y=700 to 792)
    draw.rounded_rectangle([60, 700, 1020, 792], radius=20, fill=(235, 219, 178))
    draw.text((95, 746), profile["banner_left"], fill=(8, 43, 66), font=f_ban_l, anchor="lm")
    draw.text((985, 746), profile["banner_right"], fill=(8, 43, 66), font=f_ban_r, anchor="rm")

    # 4. Section 1: Included Services
    draw.text((65, 835), profile["section1_title"], fill=(8, 43, 66), font=f_sec, anchor="lm")
    draw.line([(490, 835), (1015, 835)], fill=(215, 200, 165), width=2)

    y_row = 885
    for col1, col2, col3 in profile["section1_rows"]:
        draw.text((65, y_row), col1, fill=(8, 43, 66), font=f_row_b, anchor="lm")
        draw.text((385, y_row), col2, fill=(50, 65, 80), font=f_row_r, anchor="lm")
        draw.text((1015, y_row), col3, fill=(16, 110, 60), font=f_row_b, anchor="rm")
        y_row += 52

    # 5. Section 2: White Box with Gold Border for Required Documents (y=1065 to 1445)
    draw.text((65, 1055), profile["section2_title"], fill=(8, 43, 66), font=f_sec, anchor="lm")
    draw.rounded_rectangle([60, 1085, 1020, 1440], radius=20, fill=(255, 255, 255), outline=(215, 200, 165), width=2)

    y_doc = 1138
    for b in profile["section2_bullets"]:
        draw.text((90, y_doc), b, fill=(15, 35, 55), font=f_doc, anchor="lm")
        y_doc += 72

    # 6. Bottom Cream Card (y=1470 to 1595)
    draw.rounded_rectangle([60, 1470, 1020, 1595], radius=20, fill=(242, 235, 214))
    draw.text((540, 1515), profile["footer_note"], fill=(8, 43, 66), font=f_row_b, anchor="mm")
    draw.text((540, 1560), "AL-BAHR HORIZON TRAVELS & CONSULTANTS (PVT.) LTD. — LAHORE", fill=(60, 75, 90), font=f_tag, anchor="mm")

    img.save(out_path, "PNG")
    print(out_path)

if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "umrah"
    out_d = sys.argv[2] if len(sys.argv) > 2 else "/home/test/.gemini/antigravity/scratch/whatsapp-automation/posters"
    generate_poster(q, out_d)
