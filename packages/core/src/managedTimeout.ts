/**
 * Creates a managed timeout that can be restarted or canceled.
 * Returns an object with restart() and cancel() methods.
 */
export function setManagedTimeout(callback: () => void | Promise<void>, delay: number): {
    restart(): void;
    cancel(): void;
} {
    let timeoutId: NodeJS.Timeout | undefined;

    function start(): void {
        timeoutId = setTimeout(() => {
            void callback();
        }, delay);
    }

    function cancel(): void {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
        }
    }

    start();

    return {
        restart: (): void => {
            cancel();
            start();
        },
        cancel,
    };
}
