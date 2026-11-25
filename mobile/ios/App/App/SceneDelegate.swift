import UIKit
import Capacitor
import VisionKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// The app's bridge view controller: registers plugins that live in this target.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DocScannerPlugin())
    }
}

/// Apple's document camera (VisionKit): finds page edges, flattens and crops each page,
/// and scans several pages in one go. JS: DocScanner.scan() -> { images: [file URLs] }.
/// Pages are written to the app's temporary folder and never leave the device.
@objc(DocScannerPlugin)
public class DocScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {
    public let identifier = "DocScannerPlugin"
    public let jsName = "DocScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]
    private var pendingCall: CAPPluginCall?

    @objc func scan(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else {
            call.reject("Document scanning is not supported on this device", "UNAVAILABLE")
            return
        }
        DispatchQueue.main.async {
            self.pendingCall?.reject("Replaced by a new scan", "CANCELLED")
            self.pendingCall = call
            let scanner = VNDocumentCameraViewController()
            scanner.delegate = self
            self.bridge?.viewController?.present(scanner, animated: true)
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scans", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        var images: [String] = []
        for i in 0..<scan.pageCount {
            let url = dir.appendingPathComponent("scan-\(stamp)-\(i + 1).jpg")
            if let data = scan.imageOfPage(at: i).jpegData(compressionQuality: 0.85) {
                do {
                    try data.write(to: url, options: .completeFileProtection)
                    images.append(url.absoluteString)
                } catch {
                    CAPLog.print("DocScanner: could not save page \(i + 1): \(error)")
                }
            }
        }
        controller.dismiss(animated: true) {
            self.pendingCall?.resolve(["images": images])
            self.pendingCall = nil
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true) {
            self.pendingCall?.reject("User cancelled", "CANCELLED")
            self.pendingCall = nil
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true) {
            self.pendingCall?.reject(error.localizedDescription, "FAILED")
            self.pendingCall = nil
        }
    }
}
