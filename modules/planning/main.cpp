#include "scene_snapshot.h"

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include <robot_system/arm_system_api.h>

namespace {

using nlohmann::json;

void send(std::FILE *channel, const json &response)
{
    const auto message = response.dump(-1, ' ', false, json::error_handler_t::replace) + '\n';
    if (std::fwrite(message.data(), 1, message.size(), channel) != message.size() ||
        std::fflush(channel) != 0)
        throw std::runtime_error("无法向桌面端写入规划场景。");
}

void loadScene(const json &request, rp_arm::ArmSystemPtr &current, json &reply)
{
    namespace fs = std::filesystem;
    const auto kind = request.at("kind").get<std::string>();
    const auto path = fs::absolute(request.at("path").get<std::string>());
    if (kind != "package" && kind != "urdf")
        throw std::runtime_error("规划场景格式无效。");

    // One Punch 的文件入口按进程工作目录解析相对网格路径。
    fs::current_path(kind == "package" ? path : path.parent_path());
    auto next = kind == "package" ? rp_arm::createArmSystemFromPackageDir(path.string())
                                  : rp_arm::createArmSystem(path.string());
    if (!next) throw std::runtime_error("One Punch 无法初始化场景。");
    reply["scene"] = exportSceneSnapshot(*next);
    current = std::move(next);
}

} // namespace

int main()
{
    // One Punch 会向 stdout/stderr 写日志，协议响应使用独立的管道。
    const auto closeChannel = [](std::FILE *file) { std::fclose(file); };
    const std::unique_ptr<std::FILE, decltype(closeChannel)> channel(fdopen(3, "w"), closeChannel);
    if (!channel) return 1;

    rp_arm::ArmSystemPtr current;
    std::string line;
    while (std::getline(std::cin, line)) {
        json reply = {{"id", nullptr}, {"ok", false}};
        try {
            const auto request = json::parse(line);
            reply["id"] = request.at("id").get<std::string>();
            const auto method = request.at("method").get<std::string>();
            if (method == "loadScene") {
                loadScene(request, current, reply);
            } else if (method == "getScene") {
                if (!current) throw std::runtime_error("尚未加载规划场景。");
                reply["scene"] = exportSceneSnapshot(*current);
            } else {
                throw std::runtime_error("不支持的规划场景操作。");
            }
            reply["ok"] = true;
        } catch (const std::exception &error) {
            reply["error"] = error.what();
        }

        try {
            send(channel.get(), reply);
        } catch (const std::exception &error) {
            std::cerr << error.what() << '\n';
            return 1;
        }
    }
}
