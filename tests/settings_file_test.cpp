// Pure config writer test: compile with src/mod_dashboard_settings.cpp, no realm required.
#include "mod_dashboard_settings.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace fs = std::filesystem;

std::string Read(fs::path const& path)
{
    std::ifstream in(path, std::ios::binary);
    return { std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>() };
}

void Check(bool condition, char const* message)
{
    if (!condition)
        throw std::runtime_error(message);
}

int main()
{
    auto directory = fs::temp_directory_path() /
        ("dashboard-settings-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directory(directory);
    int result = 0;
    try
    {
        auto file = directory / "module.conf";
        std::string const original = "\xEF\xBB\xBF# Key = 0\r\nKey = 0\r\nKey.Other = 9\r\n Key = 2\r\n";
        { std::ofstream out(file, std::ios::binary); out << original; }
        Check(DashboardSettings::Write(file, "Key", "1").empty(), "write failed");
        Check(Read(file) == "\xEF\xBB\xBF# Key = 0\r\nKey = 1\r\nKey.Other = 9\r\nKey = 1\r\n",
              "duplicates, comments, BOM or newline handling failed");
        Check(Read(file.string() + ".dashboard.bak") == original, "backup does not match original");
        Check(DashboardSettings::Write(file, "Model", "").empty(), "empty value failed");
        Check(Read(file).find("Model = \"\"\r\n") != std::string::npos, "empty value not quoted");
        Check(DashboardSettings::Write(file, "Prompt", "two words").empty(), "quoted value failed");
        Check(Read(file).find("Prompt = \"two words\"\r\n") != std::string::npos, "spaces not quoted");
        auto unchanged = Read(file);
        for (auto const& value : { std::string("a\nb"), std::string("a\0b", 3), std::string("\"bad\""), std::string(2001, 'x') })
            Check(!DashboardSettings::Write(file, "Key", value).empty(), "unsafe value accepted");
        Check(!DashboardSettings::Write(file, "Key\nInjected", "1").empty(), "unsafe key accepted");
        Check(Read(file) == unchanged, "invalid input modified file");
        fs::remove(file.string() + ".dashboard.bak");
        fs::create_directory(file.string() + ".dashboard.bak");
        Check(!DashboardSettings::Write(file, "Key", "0").empty(), "backup failure ignored");
        Check(Read(file) == unchanged, "backup failure modified file");
        Check(!DashboardSettings::Write(directory / "missing.conf", "Key", "1").empty(), "missing file accepted");
        std::cout << "PASS settings file writes, duplicate keys, backups, unsafe input and failure safety\n";
    }
    catch (std::exception const& error)
    {
        std::cerr << error.what() << '\n';
        result = 1;
    }
    fs::remove_all(directory);
    return result;
}
