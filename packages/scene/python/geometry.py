"""STEP/XCAF 场景导入；源文件只读取，生成的 GLB 暂存待后端提交。"""

import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import uuid

MAX_SOURCE_BYTES = 256 * 1024 * 1024
MAX_RESOURCE_BYTES = 256 * 1024 * 1024
MAX_TRIANGLES = 2_000_000
MAX_OBJECTS = 100_000
MAX_DEPTH = 256
MAX_CYLINDERS_PER_GEOMETRY = 64
MAX_CYLINDERS_PER_IMPORT = 4096
PARTIAL_LEASE = re.compile(r'^\.dai-partial-([1-9][0-9]*)-[a-z0-9_]{8}\.glb\.lease$')


def _open_source(path):
    # 用户选择的 STEP 可以是符号链接；打开后仅信任已固定的普通文件句柄。
    if not hasattr(os, 'O_NONBLOCK'):
        raise RuntimeError('当前系统不支持安全读取 STEP。')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOCTTY', 0))
    except OSError as error:
        raise ValueError('STEP 源文件不存在或不可读取。') from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('STEP 源文件不是普通文件。')
        if info.st_size > MAX_SOURCE_BYTES:
            raise ValueError('STEP 文件超过当前导入大小限制。')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _digest_fd(descriptor):
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def _digest(path):
    descriptor = _open_source(path)
    try:
        return _digest_fd(descriptor)
    finally:
        os.close(descriptor)


def _source_fd_path(descriptor):
    root = '/proc/self/fd' if sys.platform.startswith('linux') else '/dev/fd'
    if not Path(root).is_dir():
        raise RuntimeError('当前系统不支持安全的 STEP 文件句柄读取。')
    return f'{root}/{descriptor}'


def _secure_staging(data_dir, storage_root, expected_root=None):
    """以配置的数据根为信任边界；下级目录均不得为符号链接。"""
    if (
        os.name != 'posix'
        or not hasattr(os, 'O_NOFOLLOW')
        or not hasattr(os, 'O_DIRECTORY')
        or not all(
            operation in os.supports_dir_fd
            for operation in (os.open, os.mkdir, os.stat, os.unlink, os.rename)
        )
    ):
        raise RuntimeError('当前系统不支持安全的场景目录句柄，已拒绝导入。')
    root = Path(os.path.abspath(storage_root or data_dir))
    directory = Path(os.path.abspath(data_dir))
    try:
        real_root = root.resolve(strict=True)  # 用户选择的数据根本身可以是符号链接
        root_exists = True
    except FileNotFoundError:
        if expected_root is not None:
            raise ValueError('场景数据根目录不存在。')
        real_root = root.resolve(strict=False)
        root_exists = False
    try:
        relative = directory.relative_to(root)
    except ValueError:
        try:
            # 后端已经完成 realpath 时，允许目录使用同一信任根的规范路径。
            relative = directory.relative_to(real_root)
        except ValueError as error:
            raise ValueError('场景目录不在数据根内。') from error
    parts = relative.parts + ('staging',)
    staging = real_root.joinpath(*parts)
    # 相对目录句柄逐级打开，后续创建、校验、重命名都不再次解析父目录路径。
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open('/', flags)
    try:
        for part in real_root.parts[1:]:
            if not root_exists:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if expected_root is not None:
            info = os.fstat(descriptor)
            if str(info.st_dev) != expected_root.get('dev') or str(
                info.st_ino
            ) != expected_root.get('ino'):
                raise ValueError('场景数据根目录身份已变化，请重启应用检查配置。')
        for part in parts:
            try:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            try:
                child = os.open(part, flags, dir_fd=descriptor)
            except OSError as error:
                raise ValueError('场景目录包含符号链接或不可访问的目录。') from error
            os.close(descriptor)
            descriptor = child
        return staging, staging, descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _create_partial(directory, directory_fd):
    """登记由当前进程创建的私有暂存文件；无法完成登记则删除新文件。"""
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    for _ in range(32):
        name = f'.dai-partial-{os.getpid()}-{secrets.token_hex(4)}.glb'
        try:
            descriptor = os.open(name, flags, 0o600, dir_fd=directory_fd)
            break
        except FileExistsError:
            continue
    else:
        raise RuntimeError('无法创建独立的场景暂存文件。')
    temporary = directory / name
    lease = directory / (name + '.lease')
    lease_created = False
    try:
        info = os.fstat(descriptor)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        lease_fd = os.open(lease.name, flags, 0o600, dir_fd=directory_fd)
        lease_created = True
        with os.fdopen(lease_fd, 'w', encoding='utf-8') as stream:
            json.dump(
                {
                    'pid': os.getpid(),
                    'name': temporary.name,
                    'dev': info.st_dev,
                    'ino': info.st_ino,
                },
                stream,
            )
        return descriptor, temporary, lease
    except BaseException:
        os.close(descriptor)
        os.unlink(temporary.name, dir_fd=directory_fd)
        if lease_created:
            os.unlink(lease.name, dir_fd=directory_fd)
        raise


def _rename_partial(source, target, directory_fd):
    os.rename(source, target, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)


def cleanup_stale_partials(data_dir, storage_root=None, expected_root=None):
    """仅在 Linux 清理有完整租约且创建进程已退出的普通暂存文件。"""
    if not sys.platform.startswith('linux'):
        return
    staging, directory, descriptor = _secure_staging(data_dir, storage_root, expected_root)
    try:
        if descriptor is None:
            return  # 没有固定目录句柄时无法安全清理。
        for entry in os.scandir(descriptor):
            match = PARTIAL_LEASE.fullmatch(entry.name)
            if not match:
                continue
            if len(match.group(1)) > 10:
                continue
            pid = int(match.group(1))
            if pid > 2_147_483_647:
                continue
            try:
                os.kill(pid, 0)
                continue  # 仍在运行，或 PID 已复用；保守保留。
            except ProcessLookupError:
                pass
            except (PermissionError, OSError):
                continue
            try:
                flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                lease_fd = os.open(entry.name, flags, dir_fd=descriptor)
                with os.fdopen(lease_fd, 'r', encoding='utf-8') as stream:
                    info = os.fstat(stream.fileno())
                    if (
                        not stat.S_ISREG(info.st_mode)
                        or info.st_nlink != 1
                        or info.st_uid != os.getuid()
                    ):
                        continue
                    contents = stream.read(4097)
                if len(contents) > 4096:
                    continue
                lease = json.loads(contents)
                partial_name = entry.name.removesuffix('.lease')
                if (
                    not isinstance(lease, dict)
                    or lease.get('pid') != pid
                    or lease.get('name') != partial_name
                ):
                    continue
                file_info = os.stat(partial_name, dir_fd=descriptor, follow_symlinks=False)
                if (
                    not stat.S_ISREG(file_info.st_mode)
                    or file_info.st_nlink != 1
                    or file_info.st_uid != os.getuid()
                ):
                    continue
                if (file_info.st_dev, file_info.st_ino) != (lease.get('dev'), lease.get('ino')):
                    continue
                expected = os.fstat(descriptor)
                current = os.stat(staging, follow_symlinks=False)
                if not stat.S_ISDIR(current.st_mode) or (expected.st_dev, expected.st_ino) != (
                    current.st_dev,
                    current.st_ino,
                ):
                    break
                # unlink 只删除受控目录中的目录项，不跟随符号链接。
                os.unlink(partial_name, dir_fd=descriptor)
                os.unlink(entry.name, dir_fd=descriptor)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
    finally:
        if descriptor is not None:
            os.close(descriptor)


def import_step(source_path, data_dir, storage_root=None, expected_root=None):
    try:
        # 提前加载 OCCT 依赖的 VTK 动态库。
        import vtkmodules.vtkCommonCore  # noqa: F401
        from OCP.BRep import BRep_Tool
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.Bnd import Bnd_Box
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.GeomAbs import GeomAbs_Cylinder
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.STEPConstruct import STEPConstruct_ExternRefs
        from OCP.TColStd import TColStd_SequenceOfAsciiString
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_Label, TDF_LabelSequence, TDF_Tool
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS
        from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
    except ImportError as error:
        raise RuntimeError(
            '缺少 Python 场景几何依赖，请安装 packages/scene/python/requirements.txt。'
        ) from error

    source = Path(source_path)
    if not source.is_absolute() or source.suffix.lower() not in ('.step', '.stp'):
        raise ValueError('请选择 STEP 绝对路径。')
    source_fd = _open_source(source)
    try:
        initial_hash = _digest_fd(source_fd)
        reader = STEPCAFControl_Reader()
        reader.SetColorMode(True)
        reader.SetNameMode(True)
        if reader.ReadFile(_source_fd_path(source_fd)) != IFSelect_RetDone:
            raise ValueError('STEP 解析失败，请确认文件内容有效。')
    finally:
        os.close(source_fd)
    lengths = TColStd_SequenceOfAsciiString()
    reader.Reader().FileUnits(
        lengths, TColStd_SequenceOfAsciiString(), TColStd_SequenceOfAsciiString()
    )
    if lengths.Length() == 0 or any(
        not lengths.Value(index).ToCString().strip() for index in range(1, lengths.Length() + 1)
    ):
        raise ValueError('STEP 长度单位缺失或无法解析，不能可靠计算模型尺寸。')
    references = STEPConstruct_ExternRefs(reader.Reader().WS())
    references.LoadExternRefs()
    if references.NbExternRefs():
        raise ValueError('暂不支持包含外部引用的 STEP 文件。')
    document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    if not reader.Transfer(document):
        raise ValueError('STEP 几何转换失败。')
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shapes.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise ValueError('STEP 文件没有可显示的几何。')

    def key(label):
        value = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, value)
        return value.ToCString()

    def name(label):
        value = TDataStd_Name()
        return (
            value.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), value) else ''
        )

    records = {}
    geometries = {}

    def visit(label, parent, path, ancestors):
        if len(records) >= MAX_OBJECTS or len(ancestors) >= MAX_DEPTH:
            raise ValueError('STEP 装配对象数量或嵌套深度超过限制。')
        label_key = key(label)
        definition = label
        references_seen = set()
        while XCAFDoc_ShapeTool.IsReference_s(definition):
            reference_key = key(definition)
            if reference_key in references_seen:
                raise ValueError('STEP 包含循环引用。')
            references_seen.add(reference_key)
            referred = TDF_Label()
            if not XCAFDoc_ShapeTool.GetReferredShape_s(definition, referred):
                raise ValueError('STEP 包含无效的装配引用。')
            definition = referred
        definition_key = key(definition)
        if definition_key in ancestors:
            raise ValueError('STEP 包含循环装配。')
        instance_name = name(label)
        if not instance_name or instance_name.startswith('=>['):
            instance_name = name(definition)
        instance_name = instance_name or 'Unnamed'
        if len(instance_name) > 1000:
            raise ValueError('STEP 对象名称超过长度限制。')
        source_key = path + '/' + label_key + '@' + definition_key
        if len(source_key) > 4096:
            raise ValueError('STEP 对象路径超过长度限制。')
        record = {
            'id': uuid.uuid4().hex,
            'name': instance_name,
            'parentId': parent,
            'sourceKey': source_key,
        }
        records[source_key] = record
        record['_label'] = label
        record['_definition'] = definition
        children = TDF_LabelSequence()
        if XCAFDoc_ShapeTool.IsAssembly_s(definition):
            XCAFDoc_ShapeTool.GetComponents_s(definition, children)
            if children.Length() == 0:
                raise ValueError('STEP 包含空装配。')
            for index in range(1, children.Length() + 1):
                visit(children.Value(index), record['id'], source_key, ancestors | {definition_key})
        else:
            geometries.setdefault(definition_key, definition)
            record['_geometryKey'] = definition_key

    for index in range(1, roots.Length() + 1):
        visit(roots.Value(index), None, '', set())
    if not geometries:
        raise ValueError('STEP 文件没有可显示的几何。')

    triangles = 0
    bounds_by_geometry = {}
    cylinders_by_geometry = {}
    truncated_geometries = set()
    for geometry_key, label in geometries.items():
        shape = XCAFDoc_ShapeTool.GetShape_s(label)
        if shape.IsNull():
            raise ValueError('STEP 对象没有有效几何。')
        shape = shape.Located(TopLoc_Location())
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(shape, box, False, False)
        if box.IsVoid() or box.IsOpen():
            raise ValueError('STEP 对象缺少有限的几何边界。')
        coordinates = box.Get()
        if not all(math.isfinite(value) for value in coordinates):
            raise ValueError('STEP 对象几何边界无效。')
        minimum = [value * 0.001 for value in coordinates[:3]]
        maximum = [value * 0.001 for value in coordinates[3:]]
        bounds_by_geometry[geometry_key] = {
            'min': minimum,
            'max': maximum,
            'size': [maximum[index] - minimum[index] for index in range(3)],
            'unit': 'm',
            'space': 'object-local',
        }
        BRepMesh_IncrementalMesh(shape, 0.1, False, 0.5, True)
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        cylinders = []
        face_index = 0
        while explorer.More():
            face_index += 1
            face = TopoDS.Face_s(explorer.Current())
            surface = BRepAdaptor_Surface(face, True)
            if surface.GetType() == GeomAbs_Cylinder:
                if len(cylinders) >= MAX_CYLINDERS_PER_GEOMETRY:
                    truncated_geometries.add(geometry_key)
                else:
                    cylinder = surface.Cylinder()
                    axis = cylinder.Axis()
                    point = axis.Location()
                    direction = axis.Direction()
                    origin = [point.X() * 0.001, point.Y() * 0.001, point.Z() * 0.001]
                    vector = [direction.X(), direction.Y(), direction.Z()]
                    radius = cylinder.Radius() * 0.001
                    if (
                        not all(math.isfinite(value) for value in origin + vector + [radius])
                        or radius <= 0
                    ):
                        raise ValueError('STEP 圆柱面参数无效。')
                    cylinders.append(
                        {
                            'faceIndex': face_index,
                            'axisOrigin': origin,
                            'axisDirection': vector,
                            'radius': radius,
                            'unit': 'm',
                            'space': 'object-local',
                            'evidence': 'analytic-cylinder',
                            'kinematics': 'unknown',
                        }
                    )
            location = TopLoc_Location()
            mesh = BRep_Tool.Triangulation_s(face, location)
            if mesh is None or mesh.NbTriangles() == 0:
                raise ValueError('STEP 有无法生成网格的曲面，未保存不完整的显示资源。')
            triangles += mesh.NbTriangles()
            if triangles > MAX_TRIANGLES:
                raise ValueError('STEP 网格超过当前三角形数量限制。')
            explorer.Next()
        cylinders_by_geometry[geometry_key] = cylinders
    if triangles == 0:
        raise ValueError('STEP 文件没有可显示的三角网格。')
    from gltf import create_glb

    payload = create_glb(document, shapes, list(records.values()), geometries, MAX_RESOURCE_BYTES)
    if _digest(source) != initial_hash:
        raise ValueError('读取期间 STEP 文件已发生变化，请重新导入。')
    staging, write_staging, staging_fd = _secure_staging(data_dir, storage_root, expected_root)
    temporary = lease = None
    file_fd = None
    try:
        file_fd, temporary, lease = _create_partial(write_staging, staging_fd)
        file_info = os.fstat(file_fd)
        entry_info = os.stat(temporary.name, dir_fd=staging_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(entry_info.st_mode)
            or entry_info.st_nlink != 1
            or (file_info.st_dev, file_info.st_ino) != (entry_info.st_dev, entry_info.st_ino)
        ):
            raise ValueError('场景暂存文件在写入前发生变化。')
        # 只写持有的独占文件句柄；即使目录项被替换也不会写入替换目标。
        view = memoryview(payload)
        while view:
            written = os.write(file_fd, view)
            if written <= 0:
                raise OSError('场景资源写入失败。')
            view = view[written:]
        target = staging / (uuid.uuid4().hex + '.glb')
        if staging_fd is not None:
            expected = os.fstat(staging_fd)
            current = os.stat(staging, follow_symlinks=False)
            if not stat.S_ISDIR(current.st_mode) or (expected.st_dev, expected.st_ino) != (
                current.st_dev,
                current.st_ino,
            ):
                raise ValueError('场景目录在写入期间发生变化。')
        entry_info = os.stat(temporary.name, dir_fd=staging_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(entry_info.st_mode)
            or entry_info.st_nlink != 1
            or (file_info.st_dev, file_info.st_ino) != (entry_info.st_dev, entry_info.st_ino)
        ):
            raise ValueError('场景暂存文件在写入期间发生变化。')
        _rename_partial(temporary.name, target.name, staging_fd)
        entry_info = os.stat(target.name, dir_fd=staging_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(entry_info.st_mode)
            or entry_info.st_nlink != 1
            or (file_info.st_dev, file_info.st_ino) != (entry_info.st_dev, entry_info.st_ino)
        ):
            os.unlink(target.name, dir_fd=staging_fd)
            raise ValueError('场景暂存文件在提交期间发生变化。')
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary.name, dir_fd=staging_fd)
            except FileNotFoundError:
                pass
        if lease is not None:
            try:
                os.unlink(lease.name, dir_fd=staging_fd)
            except FileNotFoundError:
                pass
        if file_fd is not None:
            os.close(file_fd)
        if staging_fd is not None:
            os.close(staging_fd)
    remaining_cylinders = MAX_CYLINDERS_PER_IMPORT
    any_truncated = False
    for record in records.values():
        del record['_label']
        del record['_definition']
        geometry_key = record.pop('_geometryKey', None)
        if geometry_key is not None:
            record['geometryBounds'] = bounds_by_geometry[geometry_key]
            candidates = cylinders_by_geometry[geometry_key]
            accepted = candidates[:remaining_cylinders]
            remaining_cylinders -= len(accepted)
            if accepted:
                record['cylinderCandidates'] = accepted
            if geometry_key in truncated_geometries or len(accepted) < len(candidates):
                record['cylinderCandidatesTruncated'] = True
                any_truncated = True
    warnings = ['已保留装配节点、实例位置及可导出的颜色；运动结构与复杂文件完整性尚未验证。']
    if any_truncated:
        warnings.append('圆柱面候选数量超过限制，结果已截断。')
    return {
        'source': {'path': str(source), 'sha256': initial_hash},
        'resource': {
            'path': str(target),
            'format': 'glb',
            'byteLength': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(),
        },
        'objects': list(records.values()),
        'complete': False,
        'warnings': warnings,
    }
