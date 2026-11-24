#include "scene_snapshot.h"

#include <filesystem>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

using nlohmann::json;

json origin(const urdf::Pose &pose)
{
    double roll, pitch, yaw;
    pose.rotation.getRPY(roll, pitch, yaw);
    return {{"xyz", {pose.position.x, pose.position.y, pose.position.z}}, {"rpy", {roll, pitch, yaw}}};
}

using Assets = std::map<std::string, std::string>;

std::string meshAsset(const std::string &reference, Assets &assets)
{
    std::string path = reference;
    if (path.starts_with("file://")) path.erase(0, 7);
    path = std::filesystem::absolute(path).lexically_normal().string();
    if (!std::filesystem::is_regular_file(path))
        throw std::runtime_error("无法读取场景网格：" + path);
    if (const auto it = assets.find(path); it != assets.end()) return it->second;

    // 标识仅在当前场景快照内使用。
    std::ostringstream id;
    id << std::hex << std::setfill('0') << std::setw(64) << assets.size() << ".stl";
    return assets.emplace(path, id.str()).first->second;
}

json geometry(const urdf::Geometry &shape, Assets &assets)
{
    switch (shape.type) {
        case urdf::Geometry::BOX: {
            const auto &size = static_cast<const urdf::Box &>(shape).dim;
            return {{"type", "box"}, {"size", {size.x, size.y, size.z}}};
        }
        case urdf::Geometry::SPHERE:
            return {{"type", "sphere"}, {"radius", static_cast<const urdf::Sphere &>(shape).radius}};
        case urdf::Geometry::CYLINDER: {
            const auto &cylinder = static_cast<const urdf::Cylinder &>(shape);
            return {{"type", "cylinder"}, {"radius", cylinder.radius}, {"length", cylinder.length}};
        }
        case urdf::Geometry::MESH: {
            const auto &mesh = static_cast<const urdf::Mesh &>(shape);
            return {{"type", "mesh"}, {"asset", meshAsset(mesh.filename, assets)},
                    {"scale", {mesh.scale.x, mesh.scale.y, mesh.scale.z}}};
        }
        default:
            throw std::runtime_error("场景包含当前无法显示的几何类型。");
    }
}

const char *jointType(const urdf::Joint &joint)
{
    switch (joint.type) {
        case urdf::Joint::FIXED: return "fixed";
        case urdf::Joint::REVOLUTE: return "revolute";
        case urdf::Joint::CONTINUOUS: return "continuous";
        case urdf::Joint::PRISMATIC: return "prismatic";
        default: throw std::runtime_error("无法显示关节：" + joint.name);
    }
}

json objects(const auto &items)
{
    json result = json::array();
    for (const auto &item : items) {
        const Eigen::Quaterniond rotation(item->pose.linear());
        const auto position = item->pose.translation();
        result.push_back({
            {"name", item->name}, {"frame", item->frame_id}, {"robot", item->attached_robot},
            {"xyz", {position.x(), position.y(), position.z()}},
            {"quaternion", {rotation.x(), rotation.y(), rotation.z(), rotation.w()}}
        });
    }
    return result;
}

} // namespace

nlohmann::json exportSceneSnapshot(rp_arm::ArmSystem &system)
{
    const auto scene = system.getPlanningScene();
    const auto model = scene->getRobotModel();
    const auto urdf = model->getURDF();
    const auto positions = scene->getCurrentState().getCachedJoints();
    Assets assets;
    json links = json::array();
    json joints = json::array();
    json groups = json::array();
    json collisionGeometry = json::array();

    for (const auto &[name, link] : urdf->links_) {
        json visuals = json::array();
        for (const auto &visual : link->visual_array) {
            json appearance = {
                {"origin", origin(visual->origin)}, {"geometry", geometry(*visual->geometry, assets)}
            };
            if (visual->material) {
                const auto &color = visual->material->color;
                appearance["color"] = {color.r, color.g, color.b, color.a};
            }
            visuals.push_back(std::move(appearance));
        }
        links.push_back({{"id", "link:" + name}, {"name", name}, {"visuals", std::move(visuals)}});
        for (const auto &collision : link->collision_array) {
            collisionGeometry.push_back({
                {"linkId", "link:" + name}, {"origin", origin(collision->origin)},
                {"geometry", geometry(*collision->geometry, assets)}
            });
        }
    }

    for (const auto &[name, joint] : urdf->joints_) {
        json entry = {
            {"id", "joint:" + name}, {"name", name}, {"type", jointType(*joint)},
            {"parentId", "link:" + joint->parent_link_name}, {"childId", "link:" + joint->child_link_name},
            {"origin", origin(joint->parent_to_joint_origin_transform)},
            {"axis", {joint->axis.x, joint->axis.y, joint->axis.z}},
            {"position", positions.contains(name) ? positions.at(name) : 0.0}
        };
        if (joint->limits && joint->type != urdf::Joint::FIXED) {
            const auto &limit = *joint->limits;
            entry["limit"] = {{"effort", limit.effort}, {"velocity", limit.velocity}};
            if (joint->type != urdf::Joint::CONTINUOUS) {
                entry["limit"]["lower"] = limit.lower;
                entry["limit"]["upper"] = limit.upper;
            }
        }
        joints.push_back(std::move(entry));
    }

    for (const auto &name : model->getJointModelGroupNames()) {
        groups.push_back({
            {"name", name}, {"joints", model->getJointModelGroup(name)->getActiveJointModelNames()}
        });
    }

    json resources = json::array();
    for (const auto &[path, id] : assets) resources.push_back({{"id", id}, {"path", path}});
    return {
        {"schemaVersion", 1},
        {"robot", {{"name", model->getName()}, {"rootLinkId", "link:" + model->getRootLinkName()},
                   {"links", std::move(links)}, {"joints", std::move(joints)}}},
        {"frame", scene->getPlanningFrame()},
        {"robots", system.getRobotNames()}, {"positioners", system.getPositionerNames()},
        {"groups", std::move(groups)}, {"collisionGeometry", std::move(collisionGeometry)},
        {"objects", objects(scene->getCollisionObjects())},
        {"attachedObjects", objects(scene->getAttachedCollisionObjects())},
        {"assets", std::move(resources)}
    };
}
