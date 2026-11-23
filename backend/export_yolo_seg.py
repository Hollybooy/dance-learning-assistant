"""导出 YOLO26n-seg 为 ONNX，并放到 backend/models/ 供阴影推理使用。

需要先安装 Ultralytics（AGPL-3.0，仅限课程设计等非商业用途）：
    python -m pip install ultralytics
然后运行（在 backend 目录）：
    python export_yolo_seg.py
"""

from pathlib import Path
import shutil
import sys


def main() -> int:
    try:
        from ultralytics import YOLO
    except ImportError:
        print("未安装 ultralytics：python -m pip install ultralytics")
        return 1

    model = YOLO("yolo26n-seg.pt")
    exported = model.export(format="onnx", imgsz=640, opset=17, simplify=True)
    target = Path(__file__).resolve().parent / "models" / "yolo26n-seg-640.onnx"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(exported), target)
    print(f"已导出：{target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
