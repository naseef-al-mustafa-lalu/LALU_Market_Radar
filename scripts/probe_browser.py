"""Does a real headless browser get past the NHS Digital block?"""
import re
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(locale="en-GB")
    page = ctx.new_page()
    resp = page.goto("https://digital.nhs.uk/data-and-information/publications/statistical/patients-registered-at-a-gp-practice", timeout=60000)
    page.wait_for_timeout(4000)
    print("landing:", resp.status, page.title()[:80])
    links = sorted(set(re.findall(r"patients-registered-at-a-gp-practice/[a-z]+-\d{4}", page.content())))
    print("month links:", links[-4:])
    if links:
        page.goto("https://digital.nhs.uk/data-and-information/publications/statistical/" + links[-1], timeout=60000)
        page.wait_for_timeout(3000)
        files = sorted(set(re.findall(r'https://files\.digital\.nhs\.uk/[^"\']*gp-reg-pat-prac-all\.(?:csv|zip)', page.content())))
        print("file links:", files)
        if files:
            r = ctx.request.get(files[0])
            print("download:", r.status, len(r.body()), r.body()[:200])
    b.close()
