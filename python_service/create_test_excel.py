import shutil
from datetime import datetime

from openpyxl import Workbook

from config import DB_PATH, INPUT_EXCEL, OUTPUT_DIR, RESULT_EXCEL


def backup_if_exists(path):
    if not path.exists():
        return None

    backup_dir = path.parent / "backup_for_test"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{path.name}.{stamp}.bak"
    shutil.copy2(path, backup_path)
    return backup_path


def archive_if_exists(path):
    if not path.exists():
        return None

    backup_dir = path.parent / "backup_for_test"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{path.name}.{stamp}.bak"
    path.replace(backup_path)
    return backup_path


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    input_backup = backup_if_exists(INPUT_EXCEL)
    result_backup = archive_if_exists(RESULT_EXCEL)
    db_backup = archive_if_exists(DB_PATH)

    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(["id", "问题", "关键词", "豆包", "千问", "deepseek", "元宝", "文心一言"])
    ws.append([
        1,
        "第一条测试：贵州地区有哪些商科、管理类本科院校值得推荐？",
        "贵阳商学院，贵州商学院",
        None,
        None,
        None,
        None,
        None,
    ])
    ws.append([
        2,
        "第二条测试：贵州读大学生活费和商科院校选择怎么比较？",
        "贵州商学院 or 贵阳学院",
        None,
        None,
        None,
        None,
        None,
    ])

    for col in range(1, 9):
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = 24
    ws.column_dimensions["B"].width = 48
    ws.column_dimensions["C"].width = 32

    wb.save(INPUT_EXCEL)

    print(f"已生成测试 Excel：{INPUT_EXCEL}")
    if input_backup:
        print(f"原 input.xlsx 已备份：{input_backup}")
    if result_backup:
        print(f"原 result.xlsx 已归档：{result_backup}")
    if db_backup:
        print(f"原 progress.sqlite 已归档：{db_backup}")


if __name__ == "__main__":
    main()
