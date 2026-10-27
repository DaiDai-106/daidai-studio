---
name: scene-building
description: 导入 STEP，观察和查询已保存场景。
---

# 场景导入与观察

已有显示时直接使用，不重新导入。未选 STEP 时调用 `scene_list_steps`：完整列表只有一个文件可直接选择；多个或列表不完整时询问用户，除非用户已指定。首次显示时选择文件，再用最新 `selectedSourcePath` 调用 `cad_import_step`、等待完成并调用 `cad_build_display`（preview、alignment 特征），等待显示发布。报告显示不完整或警告。

使用 `scene_inspect` 查看对象，使用 `scene_get_features` 按对象分页获取特征的世界坐标；在整个场景中寻找平面或圆柱时，可用 `scene_find_features` 按世界轴方向和高度筛选并分页。几何结果本身不证明对象的用途；其 origin 也不能代表完整几何范围。不要用 Bash 读取场景文件或自行换算坐标。需要看整体时用 `viewport_capture` 的 `overview` 一次获取六个标准视角。图片可能遮挡零件，不是精确测量。
