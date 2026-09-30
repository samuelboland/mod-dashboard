#include "mod_dashboard_settings.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iterator>
#include <sstream>
#include <system_error>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace DashboardSettings
{
    constexpr size_t MAX_CONFIG_BYTES = 1024 * 1024;

    bool ValidValue(std::string const& value)
    {
        return value.size() <= 2000 && std::none_of(value.begin(), value.end(), [](unsigned char c)
        {
            return c == '"' || c < 32 || c == 127;
        });
    }

    std::string Write(std::filesystem::path const& file, std::string const& key, std::string const& value)
    {
        if (key.empty() || key.size() > 200 || !std::all_of(key.begin(), key.end(), [](unsigned char c)
            { return std::isalnum(c) || c == '.' || c == '_' || c == '-'; }) || !ValidValue(value))
            return "Invalid setting key or value";

        std::error_code ec;
        auto status = std::filesystem::symlink_status(file, ec);
        if (ec || !std::filesystem::is_regular_file(status))
            return "Settings file must be an existing regular file";
        auto size = std::filesystem::file_size(file, ec);
        if (ec || size > MAX_CONFIG_BYTES)
            return "Cannot read settings file, or it exceeds 1 MiB";
        std::ifstream in(file, std::ios::binary);
        if (!in)
            return "Cannot read settings file";
        std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        if (in.bad())
            return "Cannot read settings file";
        in.close();

        std::string bom;
        if (content.compare(0, 3, "\xEF\xBB\xBF") == 0)
        {
            bom = content.substr(0, 3);
            content.erase(0, 3);
        }
        std::string const newline = content.find("\r\n") == std::string::npos ? "\n" : "\r\n";
        bool const plain = !value.empty() && std::all_of(value.begin(), value.end(), [](unsigned char c)
            { return std::isalnum(c) || c == '.' || c == '-' || c == '_' || c == ':' || c == '/'; });
        std::string const written = key + " = " + (plain ? value : "\"" + value + "\"");
        std::stringstream input(content);
        std::string output = bom;
        bool replaced = false;
        for (std::string line; std::getline(input, line); )
        {
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            size_t start = line.find_first_not_of(" \t");
            if (start != std::string::npos && line.compare(start, key.size(), key) == 0)
            {
                size_t after = line.find_first_not_of(" \t", start + key.size());
                if (after != std::string::npos && line[after] == '=')
                {
                    // Updating all duplicates avoids a later assignment silently winning.
                    line = written;
                    replaced = true;
                }
            }
            output += line + newline;
            if (output.size() > MAX_CONFIG_BYTES)
                return "Updated settings file exceeds 1 MiB; no changes were made";
        }
        if (!replaced)
            output += written + newline;
        if (output.size() > MAX_CONFIG_BYTES)
            return "Updated settings file exceeds 1 MiB; no changes were made";

        std::filesystem::path backup = file;
        backup += ".dashboard.bak";
        std::filesystem::copy_file(file, backup, std::filesystem::copy_options::overwrite_existing, ec);
        if (ec)
            return "Cannot back up settings file; no changes were made";
        std::filesystem::path temp = file;
        temp += ".dashboard.tmp";
        auto fail = [&](std::string message)
        {
            std::error_code ignored;
            std::filesystem::remove(temp, ignored);
            return message;
        };
        // Copy first so the staging file inherits the config's access restrictions
        // before it contains any new data, including unrelated secrets in the file.
        std::filesystem::copy_file(file, temp, std::filesystem::copy_options::overwrite_existing, ec);
        if (ec)
            return fail("Cannot prepare temporary settings file");
        std::ofstream out(temp, std::ios::binary | std::ios::trunc);
        if (!out)
            return fail("Cannot open temporary settings file");
        out << output;
        out.close();
        if (!out)
            return fail("Cannot write temporary settings file");
        std::filesystem::permissions(temp, status.permissions(), ec);
        if (ec)
            return fail("Cannot preserve settings file permissions");
#ifdef _WIN32
        // ReplaceFile preserves the original Windows ACL and other file metadata.
        if (!ReplaceFileW(file.c_str(), temp.c_str(), nullptr, 0, nullptr, nullptr))
            return fail("Cannot replace settings file");
#else
        std::filesystem::rename(temp, file, ec);
        if (ec)
            return fail("Cannot replace settings file");
#endif
        return {};
    }
}
