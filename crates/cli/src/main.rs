use clap::{Parser, Subcommand};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};

#[derive(Parser)]
#[command(
    version,
    about = "Native Rust launcher for existing Minecraft installations (offline accounts)"
)]
struct Cli {
    /// Project directory containing Minecraft/ and PCL-Linux/runtime/.
    #[arg(long, global = true, default_value = ".")]
    project: PathBuf,
    /// Game root; defaults to PROJECT/Minecraft/.minecraft.
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Print all installed instances as JSON.
    List,
    /// Validate dependencies and print a launch plan as JSON (extracts native libraries).
    Plan(Launch),
    /// Launch Minecraft, write its output to the instance log, and wait for its exit.
    Run(Launch),
}
#[derive(clap::Args)]
struct Launch {
    /// Installed instance directory name.
    id: String,
    #[arg(long, default_value = "Player")]
    player: String,
    /// Maximum Java heap in GiB (2–64).
    #[arg(long, default_value_t = 8)]
    memory: u32,
}
fn execute(cli: Cli) -> Result<i32, String> {
    let project = fs::canonicalize(cli.project).map_err(|e| e.to_string())?;
    let root = cli
        .root
        .unwrap_or_else(|| project.join("Minecraft/.minecraft"));
    match cli.command {
        Action::List => {
            println!(
                "{}",
                serde_json::to_string_pretty(&pcl_core::scan_instances(&root)?)
                    .map_err(|e| e.to_string())?
            );
            Ok(0)
        }
        action => {
            let run = matches!(action, Action::Run(_));
            let launch = match action {
                Action::Plan(a) | Action::Run(a) => a,
                _ => unreachable!(),
            };
            let plan = pcl_core::build_launch_plan(
                &root,
                &project,
                &launch.id,
                &launch.player,
                launch.memory,
            )?;
            if !run {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?
                );
                return Ok(0);
            }
            fs::create_dir_all(plan.log_path.parent().ok_or("Invalid log path")?)
                .map_err(|e| e.to_string())?;
            let log = fs::File::create(&plan.log_path).map_err(|e| e.to_string())?;
            let mut child = Command::new(&plan.java)
                .args(&plan.args)
                .current_dir(&plan.game_dir)
                .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|e| e.to_string())?;
            eprintln!(
                "Minecraft PID {} · log {}",
                child.id(),
                plan.log_path.display()
            );
            Ok(child.wait().map_err(|e| e.to_string())?.code().unwrap_or(1))
        }
    }
}
fn main() {
    match execute(Cli::parse()) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Error: {error}");
            std::process::exit(1);
        }
    }
}
