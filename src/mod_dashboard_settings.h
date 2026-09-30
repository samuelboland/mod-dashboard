#pragma once

#include <filesystem>
#include <string>

namespace DashboardSettings
{
    // ConfigMgr removes quotes and cannot round-trip control characters.
    bool ValidValue(std::string const& value);

    // Replace every active assignment of key, or append it. Keep a backup and
    // atomically replace the file. An empty result means success.
    std::string Write(std::filesystem::path const& file, std::string const& key, std::string const& value);
}
