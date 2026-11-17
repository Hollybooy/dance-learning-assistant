"""把前端内置课程素材导入后端（转码+切片+骨架分析），输出 课程ID -> 后端视频ID 映射。

用法: .venv/Scripts/python.exe _import_builtin.py
幂等：按标题查重，已导入的课程跳过。
"""
import json
import re
import time
import urllib.request
import uuid
from pathlib import Path

BASE = 'http://127.0.0.1:8000'
MEDIA = Path(__file__).resolve().parent.parent / 'assets' / 'media'

COURSES = {
    'local-gufeng': 'using_total.mp4',
    'local-chinese': 'chinese-back.mp4',
    'local-hiphop': 'hiphop-back.mp4',
    'local-ballet': 'ballet-back.mp4',
    'local-swing': 'swing-back.mp4',
    'local-chacha': 'cha-cha-back.mp4',
    'local-waltz': 'waltz-back.mp4',
}


def api_json(path, method='GET', data=None, headers=None):
    req = urllib.request.Request(
        BASE + path, data=data, headers=headers or {}, method=method
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def upload_video(path: Path) -> str:
    data = path.read_bytes()
    boundary = '----dancemate' + uuid.uuid4().hex
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        'Content-Type: video/mp4\r\n\r\n'
    ).encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    result = api_json(
        '/api/videos/upload',
        method='POST',
        data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )
    return result['id']


def existing_titles():
    items = api_json('/api/videos')['items']
    return {i['title']: i['id'] for i in items}


def main():
    titles = existing_titles()
    mapping = {}
    for course_id, filename in COURSES.items():
        # 上传后 title 取文件名（去掉扩展名前后缀可能被后端规整，按包含匹配）
        hit = next((vid for title, vid in titles.items() if filename in title), None)
        if hit:
            mapping[course_id] = hit
            print(f'[skip] {course_id} -> {hit} (already imported)')
            continue
        path = MEDIA / filename
        print(f'[upload] {course_id}: {path.name} ({path.stat().st_size // 1024 // 1024}MB)...')
        vid = upload_video(path)
        mapping[course_id] = vid
        titles[filename] = vid
        print(f'         -> {vid}')

    # 等待骨架分析全部完成
    print('waiting for analysis...')
    deadline = time.time() + 900
    while time.time() < deadline:
        items = {i['id']: i for i in api_json('/api/videos')['items']}
        states = {cid: items.get(vid, {}).get('pose_status', '?') for cid, vid in mapping.items()}
        print(states)
        if all(s == 'ready' for s in states.values()):
            break
        time.sleep(15)
    else:
        raise SystemExit('timeout waiting analysis')

    print('\n=== MAPPING ===')
    print(json.dumps(mapping, indent=2))
    Path(__file__).with_name('builtin_mapping.json').write_text(
        json.dumps(mapping, indent=2), encoding='utf-8'
    )


if __name__ == '__main__':
    main()
